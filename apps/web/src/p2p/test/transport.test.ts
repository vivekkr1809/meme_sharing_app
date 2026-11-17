import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionState, ControlFrame, PairingKeys, SignalData, SignedEnvelope } from '@memes/shared';
import { deriveKeys, openSignal, sha256Hex, signSignal, toWsUrl } from '@memes/shared';
import type { TransportEvents } from '../../contracts';
import { PeerSession, tagSdp, untagSdp } from '../peer';
import { SignalingClient } from '../signaling';
import type { P2PTransport, TransportTuning } from '../transport';
import { createTransport } from '../index';
import type { FakeRelay } from './fake-relay';
import { startFakeRelay } from './fake-relay';
import { FakePeerConnection, FakeRTC } from './fake-rtc';
import { sleep, waitFor } from './util';

const A = 'device-aaaa-0001';
const B = 'device-bbbb-0002';

let keys: PairingKeys;
let otherKeys: PairingKeys;
let relay: FakeRelay;
const cleanup: (() => void)[] = [];

beforeAll(async () => {
  keys = await deriveKeys(new Uint8Array(20).fill(7));
  otherKeys = await deriveKeys(new Uint8Array(20).fill(8));
});
beforeEach(async () => {
  FakePeerConnection.reset();
  relay = await startFakeRelay();
});
afterEach(async () => {
  for (const f of cleanup.splice(0)) f();
  await relay.close();
});

const FAST: Partial<TransportTuning> = {
  negotiateTimeoutMs: 400,
  offerFallbackMs: 100,
  probeTimeoutMs: 200,
  backoff: { baseMs: 20, maxMs: 100 },
  browserHooks: false,
};

function transport(deviceId: string, extra: Partial<TransportTuning> = {}, k: PairingKeys = keys) {
  const logs: string[] = [];
  const t = createTransport({
    relayUrl: relay.url,
    keys: k,
    deviceId,
    RTCPeerConnectionImpl: FakeRTC,
    tuning: { ...FAST, ...extra, log: (m) => logs.push(m) },
  }) as P2PTransport;
  const states: ConnectionState[] = [];
  const frames: ControlFrame[] = [];
  const blobs: TransportEvents['blob'][] = [];
  t.on('state', (s) => states.push(s));
  t.on('frame', (f) => frames.push(f));
  t.on('blob', (b) => blobs.push(b));
  cleanup.push(() => t.stop());
  return { t, logs, states, frames, blobs };
}

/** A hand-driven peer: raw signaling client + manual signing, to craft edge cases. */
function rawPeer(deviceId: string, k: PairingKeys = keys) {
  const sig = new SignalingClient({ url: toWsUrl(relay.url), room: keys.roomId, deviceId, browserHooks: false });
  const received: SignalData[] = [];
  const raw: SignedEnvelope[] = [];
  sig.on('signal', async (env) => {
    raw.push(env);
    const p = await openSignal(k, env);
    if (p) received.push(p.data);
  });
  cleanup.push(() => sig.stop());
  return {
    sig,
    received,
    raw,
    async send(data: SignalData, from = deviceId, signKeys = k) {
      sig.send(await signSignal(signKeys, from, data));
    },
  };
}

const fakeSdp = (pcId: number, sid: string) => tagSdp(`v=0\r\na=fake-pc:${pcId}\r\n`, sid);

describe('P2PTransport (fake RTC)', () => {
  it('connects two peers, exchanges frames both ways and a 5 MB blob', async () => {
    const a = transport(A);
    const b = transport(B);
    a.t.start();
    await waitFor(() => a.t.state === 'waiting');
    b.t.start();
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected');
    expect(a.states).toEqual(['connecting', 'waiting', 'connecting', 'connected']);
    expect(b.states).toEqual(['connecting', 'connected']);

    const typing: ControlFrame = { type: 'typing', active: true };
    expect(a.t.send(typing)).toBe(true);
    expect(b.t.send({ type: 'profile', displayName: 'B' })).toBe(true);
    await waitFor(() => a.frames.length && b.frames.length);
    expect(b.frames).toEqual([typing]);
    expect(a.frames).toEqual([{ type: 'profile', displayName: 'B' }]);

    const data = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) & 0xff;
    data[data.length - 1] = 42;
    const memeId = await sha256Hex(data);
    await a.t.sendBlob(memeId, 'image/png', data);
    await waitFor(() => b.blobs.length === 1);
    expect(b.blobs[0]!.memeId).toBe(memeId);
    expect(await sha256Hex(b.blobs[0]!.data)).toBe(memeId);
    // Backpressure: the fake channel's bufferedAmount was respected.
    expect(a.logs.filter((l) => l.includes('dropped')).length).toBe(0);
  });

  it('send() is false and sendBlob rejects while not connected', async () => {
    const a = transport(A);
    expect(a.t.send({ type: 'typing', active: true })).toBe(false);
    await expect(a.t.sendBlob('x'.repeat(64), 'image/png', new Uint8Array(10))).rejects.toThrow(/not connected/);
    a.t.start();
    await waitFor(() => a.t.state === 'waiting');
    expect(a.t.send({ type: 'typing', active: true })).toBe(false);
  });

  it('drops invalid text frames', async () => {
    const a = transport(A);
    const b = transport(B);
    a.t.start();
    b.t.start();
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected');
    const dc = (a.t as unknown as { session: PeerSession }).session.dc;
    dc.send('nope');
    dc.send(JSON.stringify({ type: 'typing', active: 1 }));
    dc.send(JSON.stringify({ type: 'evil' }));
    a.t.send({ type: 'typing', active: false });
    await waitFor(() => b.frames.length);
    await sleep(20);
    expect(b.frames).toEqual([{ type: 'typing', active: false }]);
    expect(b.logs.filter((l) => l === 'dropped invalid control frame')).toHaveLength(3);
  });

  it('stays connected when only the relay socket drops', async () => {
    const a = transport(A);
    const b = transport(B);
    a.t.start();
    b.t.start();
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected');
    const [na, nb] = [a.states.length, b.states.length];
    const pcs = FakePeerConnection.all.length;
    relay.kick(A);
    await waitFor(() => relay.joins.filter((d) => d === A).length === 2);
    await sleep(FAST.probeTimeoutMs! * 2);
    expect(a.states.length).toBe(na);
    expect(b.states.length).toBe(nb);
    expect(FakePeerConnection.all.length).toBe(pcs); // no renegotiation: B's probe got a pong
    expect(a.t.send({ type: 'typing', active: true })).toBe(true);
    await waitFor(() => b.frames.length === 1);
  });

  it('same device re-joins elsewhere: old instance goes idle (4000), partner probes and re-offers', async () => {
    const a = transport(A);
    const old = transport(B);
    a.t.start();
    old.t.start();
    await waitFor(() => a.t.state === 'connected' && old.t.state === 'connected');
    // Make the old instance's channel vanish silently, as if its tab froze: A's DC still looks open.
    const oldSession = (old.t as unknown as { session: PeerSession }).session;
    (oldSession.dc as unknown as { peer: null }).peer = null;
    oldSession.dc.onclose = null;
    // New instance with the same deviceId; it never offers on its own (long fallback), so only
    // A's peer-joined handling (probe → timeout → re-offer) can connect them.
    const fresh = transport(B, { offerFallbackMs: 60_000 });
    fresh.t.start();
    await waitFor(() => old.t.state === 'idle');
    expect(old.logs).toContain('superseded by another session of this device; going idle');
    await waitFor(() => fresh.t.state === 'connected' && a.t.state === 'connected', { timeout: 3000 });
    expect(a.logs).not.toContain('peer-left');
    expect(a.logs).toContain('probe timed out; renegotiating');
    fresh.t.send({ type: 'typing', active: true });
    await waitFor(() => a.frames.length === 1);
    await sleep(200);
    expect(old.t.state).toBe('idle'); // and it did not fight back
    expect(relay.joins.filter((d) => d === B)).toHaveLength(2);
  });

  it('a second tab of the same device takes over immediately when the first one closes its PC', async () => {
    const a = transport(A);
    const old = transport(B);
    a.t.start();
    old.t.start();
    await waitFor(() => a.t.state === 'connected' && old.t.state === 'connected');
    const fresh = transport(B, { offerFallbackMs: 60_000 });
    fresh.t.start();
    await waitFor(() => fresh.t.state === 'connected' && a.t.state === 'connected', { timeout: 2000 });
    expect(old.t.state).toBe('idle');
  });

  it('partner leaving rejects an in-flight sendBlob and returns to waiting; reconnects after', async () => {
    const a = transport(A, { highWaterMark: 64 * 1024 });
    const b = transport(B);
    a.t.start();
    b.t.start();
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected');
    const p = a.t.sendBlob('c'.repeat(64), 'image/png', new Uint8Array(4 * 1024 * 1024));
    setTimeout(() => b.t.stop(), 5);
    await expect(p).rejects.toThrow(/connection lost/);
    await waitFor(() => a.t.state === 'waiting');
    expect(b.t.state).toBe('idle');
    b.t.start();
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected');
  });

  it('ICE failure tears down and renegotiates while both are in the room', async () => {
    const a = transport(A);
    const b = transport(B);
    a.t.start();
    b.t.start();
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected');
    const pc = (a.t as unknown as { session: PeerSession }).session.pc as unknown as FakePeerConnection;
    pc._fail();
    expect(a.t.state).not.toBe('connected');
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected', { timeout: 3000 });
    expect(a.logs).toContain('channel lost: ice-failed');
  });

  it('stop() → idle, and start() works again', async () => {
    const a = transport(A);
    const b = transport(B);
    a.t.start();
    b.t.start();
    await waitFor(() => a.t.state === 'connected');
    a.t.stop();
    expect(a.t.state).toBe('idle');
    await waitFor(() => b.t.state === 'waiting');
    a.t.start();
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected');
    expect(a.states).toEqual(['connecting', 'waiting', 'connecting', 'connected', 'idle', 'connecting', 'connected']);
  });
});

describe('signal authentication', () => {
  it('a relay tampering with envelopes prevents any connection', async () => {
    relay.opts.tamper = (env) => ({ payload: env.payload.replace('v=0', 'v=1'), mac: env.mac });
    const a = transport(A);
    const b = transport(B);
    a.t.start();
    b.t.start();
    await sleep(1200);
    expect(a.t.state).toBe('connecting');
    expect(b.t.state).toBe('connecting');
    for (const pc of FakePeerConnection.all) expect(pc.remoteDescription).toBeNull();
    expect(a.logs.filter((l) => l.includes('verification failed')).length).toBeGreaterThan(0);
    relay.opts.tamper = undefined;
    await waitFor(() => a.t.state === 'connected' && b.t.state === 'connected', { timeout: 5000 });
  });

  it('drops forged, replayed, self-addressed and malformed envelopes before touching WebRTC', async () => {
    const peer = rawPeer(B);
    peer.sig.start();
    await waitFor(() => peer.sig.status === 'joined');
    const a = transport(A, { offerFallbackMs: 60_000 });
    a.t.start();
    await waitFor(() => a.t.state === 'connecting' && relay.members(keys.roomId).length === 2);
    const pcsBefore = FakePeerConnection.all.length;

    await peer.send({ kind: 'offer', sdp: fakeSdp(999, 'aaaaaaaa') }, B, otherKeys); // wrong key
    await peer.send({ kind: 'offer', sdp: fakeSdp(999, 'bbbbbbbb') }, A); // claims to be A itself
    peer.sig.send({ payload: '{"v":1}', mac: 'AAAA' }); // garbage
    const genuine = await signSignal(keys, B, { kind: 'offer', sdp: fakeSdp(999, 'cccccccc') });
    const stale = await signSignal(keys, B, { kind: 'offer', sdp: fakeSdp(999, 'dddddddd') });
    const old = JSON.parse(stale.payload);
    old.ts -= 10 * 60_000;
    // Re-signing with a stale timestamp still fails the skew window.
    const staleEnv = { payload: JSON.stringify(old), mac: stale.mac };
    peer.sig.send(staleEnv);
    await sleep(100);
    expect(FakePeerConnection.all.length).toBe(pcsBefore);
    expect(a.logs.filter((l) => l.startsWith('dropped envelope'))).toEqual([
      'dropped envelope: verification failed',
      'dropped envelope: from self',
      'dropped envelope: verification failed',
      'dropped envelope: verification failed',
    ]);

    peer.sig.send(genuine);
    await waitFor(() => FakePeerConnection.all.length === pcsBefore + 1);
    peer.sig.send(genuine); // replay of an accepted envelope
    await sleep(100);
    expect(FakePeerConnection.all.length).toBe(pcsBefore + 1);
    expect(a.logs.at(-1)).toBe('dropped envelope: verification failed');
    // A answered, and its answer verifies with the pairing key and echoes the session tag.
    await waitFor(() => peer.received.some((d) => d.kind === 'answer'));
    const ans = peer.received.find((d) => d.kind === 'answer') as { sdp: string };
    expect(untagSdp(ans.sdp).sid).toBe('cccccccc');
  });

  it('glare: the impolite side (smaller deviceId) keeps its offer; the polite side answers', async () => {
    // Case 1: transport is A (smaller than B) → impolite.
    let peer = rawPeer(B);
    peer.sig.start();
    await waitFor(() => peer.sig.status === 'joined');
    const a = transport(A, { offerFallbackMs: 30 });
    a.t.start();
    await waitFor(() => peer.received.some((d) => d.kind === 'offer'));
    await peer.send({ kind: 'offer', sdp: fakeSdp(999, 'eeeeeeee') });
    await waitFor(() => a.logs.includes('glare: keeping our offer (impolite)'));
    expect(peer.received.some((d) => d.kind === 'answer')).toBe(false);
    a.t.stop();
    peer.sig.stop();

    // Case 2: transport is 'device-zzzz' (larger than B) → polite: drops its own offer and answers.
    peer = rawPeer(B);
    peer.sig.start();
    await waitFor(() => peer.sig.status === 'joined');
    const z = transport('device-zzzz-0003', { offerFallbackMs: 30 });
    z.t.start();
    await waitFor(() => peer.received.some((d) => d.kind === 'offer'));
    await peer.send({ kind: 'offer', sdp: fakeSdp(999, 'ffffffff') });
    await waitFor(() => peer.received.some((d) => d.kind === 'answer'));
    const ans = peer.received.find((d) => d.kind === 'answer') as { sdp: string };
    expect(untagSdp(ans.sdp).sid).toBe('ffffffff');
  });

  it('ignores answers whose session tag does not match the outstanding offer', async () => {
    const peer = rawPeer(B);
    peer.sig.start();
    await waitFor(() => peer.sig.status === 'joined');
    const a = transport(A, { offerFallbackMs: 30, negotiateTimeoutMs: 60_000 });
    a.t.start();
    await waitFor(() => peer.received.some((d) => d.kind === 'offer'));
    await peer.send({ kind: 'answer', sdp: fakeSdp(999, '01234567') });
    await waitFor(() => a.logs.includes('stale answer 01234567'));
    const pc = (a.t as unknown as { session: PeerSession }).session.pc as unknown as FakePeerConnection;
    expect(pc.remoteDescription).toBeNull();
  });
});

describe('PeerSession', () => {
  it('buffers remote ICE until the remote description is set, and holds local ICE until the offer is out', async () => {
    const out: SignalData[] = [];
    const s = new PeerSession({
      RTCPeerConnectionImpl: FakeRTC,
      role: 'answerer',
      sid: 'abcdef01',
      onSignal: (d) => out.push(d),
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
    });
    const pc = s.pc as unknown as FakePeerConnection;
    s.addIce({ candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 });
    s.addIce({ candidate: 'candidate:early2', sdpMid: '0', sdpMLineIndex: 0 });
    expect(pc.calls).toEqual([]);
    const remote = new FakePeerConnection();
    await s.acceptOffer(`v=0\r\na=fake-pc:${remote.id}\r\n`);
    expect(pc.calls).toEqual(['remote:offer', 'ice', 'ice', 'local:answer']);
    expect(pc.addedIce.map((c) => c.candidate)).toEqual(['candidate:early', 'candidate:early2']);
    await waitFor(() => out.length === 2);
    expect(out[0]!.kind).toBe('answer');
    expect(out[1]!.kind).toBe('ice');
    s.close();
    expect(pc.closed).toBe(true);
  });

  it('tags and untags SDP', () => {
    const t = tagSdp('v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n', '0123abcd');
    expect(untagSdp(t)).toEqual({ sid: '0123abcd', sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n' });
    expect(untagSdp('v=0\r\n')).toEqual({ sid: null, sdp: 'v=0\r\n' });
  });
});
