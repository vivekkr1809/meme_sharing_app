import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SignedEnvelope } from '@memes/shared';
import { toWsUrl } from '@memes/shared';
import type { SignalingEvents, SignalingOptions } from '../signaling';
import { SignalingClient } from '../signaling';
import type { FakeRelay } from './fake-relay';
import { startFakeRelay } from './fake-relay';
import { sleep, waitFor } from './util';

const ROOM = '0123456789abcdef0123456789abcdef';

let relay: FakeRelay;
const clients: SignalingClient[] = [];

beforeEach(async () => {
  relay = await startFakeRelay();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await relay.close();
});

function client(deviceId: string, opts: Partial<SignalingOptions> = {}) {
  const c = new SignalingClient({
    url: toWsUrl(relay.url),
    room: ROOM,
    deviceId,
    backoff: { baseMs: 30, maxMs: 200 },
    browserHooks: false,
    ...opts,
  });
  const log: { [K in keyof SignalingEvents]?: SignalingEvents[K][] } = {};
  for (const ev of ['status', 'joined', 'peer-joined', 'peer-left', 'signal', 'error', 'disconnected', 'superseded'] as const) {
    c.on(ev, (p) => ((log[ev] ??= [] as never[]) as unknown[]).push(p));
  }
  clients.push(c);
  return { c, log };
}

const env = (s: string): SignedEnvelope => ({ payload: s, mac: 'm' });

describe('SignalingClient', () => {
  it('joins, sees the peer come and go, and forwards envelopes both ways', async () => {
    const a = client('device-aaaa');
    a.c.start();
    await waitFor(() => a.c.status === 'joined');
    expect(a.log.joined).toEqual([{ peerPresent: false }]);
    expect(a.c.send(env('x'))).toBe(true);

    const b = client('device-bbbb');
    expect(b.c.send(env('early'))).toBe(false); // not joined yet
    b.c.start();
    await waitFor(() => b.c.status === 'joined');
    expect(b.log.joined).toEqual([{ peerPresent: true }]);
    await waitFor(() => a.log['peer-joined']?.length === 1);

    a.c.send(env('a→b'));
    b.c.send(env('b→a'));
    await waitFor(() => b.log.signal?.length && a.log.signal?.length);
    expect(b.log.signal).toEqual([env('a→b')]);
    expect(a.log.signal).toEqual([env('b→a')]);

    b.c.stop();
    expect(b.c.status).toBe('idle');
    await waitFor(() => a.log['peer-left']?.length === 1);
  });

  it('reconnects with backoff after the relay drops the socket', async () => {
    const a = client('device-aaaa');
    a.c.start();
    await waitFor(() => a.c.status === 'joined');
    relay.kick('device-aaaa');
    await waitFor(() => a.log.disconnected?.length === 1);
    expect(a.c.status).toBe('connecting');
    await waitFor(() => a.c.status === 'joined');
    expect(relay.joins.filter((d) => d === 'device-aaaa')).toHaveLength(2);
  });

  it('keeps retrying while the relay is unreachable, with growing delays', async () => {
    const port = relay.port;
    await relay.close();
    const a = client('device-aaaa', { url: `ws://127.0.0.1:${port}/ws`, backoff: { baseMs: 20, maxMs: 80, jitter: 0 } });
    a.c.start();
    await waitFor(() => (a.log.disconnected?.length ?? 0) >= 4, { timeout: 3000 });
    expect(a.log.disconnected!.slice(0, 4).map((d) => d.retryInMs)).toEqual([20, 40, 80, 80]);
    relay = await startFakeRelay({ port });
    await waitFor(() => a.c.status === 'joined', { timeout: 3000 });
  });

  it('treats a missing pong as a dead socket', async () => {
    relay.opts.answerPings = false;
    const a = client('device-aaaa', { heartbeatMs: 60 });
    a.c.start();
    await waitFor(() => a.log.disconnected?.some((d) => d.reason === 'heartbeat-timeout'), { timeout: 2000 });
    relay.opts.answerPings = true;
    await waitFor(() => a.c.status === 'joined');
    const before = a.log.disconnected!.length;
    await sleep(300); // several heartbeats, all answered
    expect(a.log.disconnected!.length).toBe(before);
  });

  it('backs off much longer on room-full', async () => {
    const a = client('device-aaaa');
    const b = client('device-bbbb');
    a.c.start();
    b.c.start();
    await waitFor(() => a.c.status === 'joined' && b.c.status === 'joined');
    const c = client('device-cccc', { roomFullDelayMs: 5000 });
    c.c.start();
    await waitFor(() => c.log.disconnected?.length);
    expect(c.log.error?.[0]?.code).toBe('room-full');
    expect(c.log.disconnected![0]!.reason).toBe('room-full');
    expect(c.log.disconnected![0]!.retryInMs).toBeGreaterThanOrEqual(5000);
    expect(c.c.status).toBe('connecting');
    expect(relay.members(ROOM).sort()).toEqual(['device-aaaa', 'device-bbbb']);
  });

  it('goes idle without reconnecting when replaced by the same deviceId (close 4000)', async () => {
    const first = client('device-aaaa');
    first.c.start();
    await waitFor(() => first.c.status === 'joined');
    const second = client('device-aaaa');
    second.c.start();
    await waitFor(() => first.log.superseded?.length === 1);
    expect(first.c.status).toBe('idle');
    await sleep(200);
    expect(relay.joins).toHaveLength(2); // the first one did not come back
    expect(second.c.status).toBe('joined');
    first.c.start(); // explicit start() takes the seat back
    await waitFor(() => second.log.superseded?.length === 1);
  });

  it('reconnectNow skips a pending backoff wait', async () => {
    const a = client('device-aaaa', { backoff: { baseMs: 60_000, maxMs: 60_000 } });
    a.c.start();
    await waitFor(() => a.c.status === 'joined');
    relay.kick('device-aaaa');
    await waitFor(() => a.log.disconnected?.length === 1);
    a.c.reconnectNow();
    await waitFor(() => a.c.status === 'joined', { timeout: 1000 });
  });

  it('a probe without pong forces a reconnect', async () => {
    const a = client('device-aaaa', { probeTimeoutMs: 50 });
    a.c.start();
    await waitFor(() => a.c.status === 'joined');
    relay.opts.answerPings = false;
    a.c.reconnectNow(); // joined → probe
    await waitFor(() => a.log.disconnected?.some((d) => d.reason === 'probe-timeout'));
    relay.opts.answerPings = true;
    await waitFor(() => a.c.status === 'joined');
  });

  it('stop() ends reconnects; start() works again afterwards', async () => {
    const a = client('device-aaaa');
    a.c.start();
    await waitFor(() => a.c.status === 'joined');
    a.c.stop();
    await sleep(150);
    expect(relay.members(ROOM)).toEqual([]);
    expect(relay.joins).toHaveLength(1);
    a.c.start();
    await waitFor(() => a.c.status === 'joined');
    expect(relay.joins).toHaveLength(2);
  });

  it('ignores garbage from the relay', async () => {
    const a = client('device-aaaa');
    a.c.start();
    await waitFor(() => a.c.status === 'joined');
    relay.inject('device-aaaa', 'not json');
    relay.inject('device-aaaa', JSON.stringify({ type: 'signal', envelope: { payload: 1 } }));
    relay.inject('device-aaaa', JSON.stringify({ type: 'joined' }));
    await sleep(50);
    expect(a.log.signal).toBeUndefined();
    expect(a.log.joined).toHaveLength(1);
    expect(a.c.status).toBe('joined');
  });
});
