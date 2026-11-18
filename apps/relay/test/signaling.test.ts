import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MAX_SIGNAL_BYTES } from '@memes/shared';
import { CLOSE_REPLACED, CLOSE_ROOM_FULL, createRelay, type Relay } from '../src/relay';
import { connect, DEV_A, DEV_B, DEV_C, joined, ROOM, ROOM2, until, wsUrl, type TestClient } from './helpers';

let relay: Relay;
const clients: TestClient[] = [];
const track = <T extends TestClient>(c: T) => (clients.push(c), c);

beforeEach(async () => {
  relay = await createRelay({ port: 0 });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await relay.close();
});

describe('join / presence', () => {
  it('reports peerPresent and notifies the first peer', async () => {
    const a = track(await connect(relay.url));
    a.send({ type: 'join', room: ROOM, deviceId: DEV_A });
    expect(await a.next()).toEqual({ type: 'joined', peerPresent: false });

    const b = track(await connect(relay.url));
    b.send({ type: 'join', room: ROOM, deviceId: DEV_B });
    expect(await b.next()).toEqual({ type: 'joined', peerPresent: true });
    expect(await a.next()).toEqual({ type: 'peer-joined' });
    expect(relay.stats()).toEqual({ rooms: 1, sockets: 2, joined: 2 });
  });

  it('sends peer-left when a peer disconnects and deletes empty rooms', async () => {
    const a = track(await joined(relay.url, ROOM, DEV_A));
    const b = track(await joined(relay.url, ROOM, DEV_B));
    expect(await a.next()).toEqual({ type: 'peer-joined' });

    b.close();
    expect(await a.next()).toEqual({ type: 'peer-left' });
    expect(relay.stats()).toEqual({ rooms: 1, sockets: 1, joined: 1 });

    a.close();
    await until(() => relay.stats().sockets === 0);
    expect(relay.stats()).toEqual({ rooms: 0, sockets: 0, joined: 0 });
  });

  it('keeps rooms isolated', async () => {
    const a = track(await joined(relay.url, ROOM, DEV_A));
    const b = track(await connect(relay.url));
    b.send({ type: 'join', room: ROOM2, deviceId: DEV_B });
    expect(await b.next()).toEqual({ type: 'joined', peerPresent: false });
    expect(await a.drain(100)).toEqual([]);
    expect(relay.stats().rooms).toBe(2);
  });

  it('rejects a third device with room-full and closes it', async () => {
    track(await joined(relay.url, ROOM, DEV_A));
    track(await joined(relay.url, ROOM, DEV_B));
    const c = track(await connect(relay.url));
    c.send({ type: 'join', room: ROOM, deviceId: DEV_C });
    const m = await c.next();
    expect(m).toMatchObject({ type: 'error', code: 'room-full' });
    expect((await c.closed).code).toBe(CLOSE_ROOM_FULL);
    expect(relay.stats()).toMatchObject({ rooms: 1, joined: 2 });
  });

  it('replaces the socket of a re-joining device without peer-left churn', async () => {
    const a1 = track(await joined(relay.url, ROOM, DEV_A));
    const b = track(await connect(relay.url));
    b.send({ type: 'join', room: ROOM, deviceId: DEV_B });
    expect(await b.next()).toEqual({ type: 'joined', peerPresent: true });
    expect(await a1.next()).toEqual({ type: 'peer-joined' });

    const a2 = track(await connect(relay.url));
    a2.send({ type: 'join', room: ROOM, deviceId: DEV_A });
    expect(await a2.next()).toEqual({ type: 'joined', peerPresent: true });
    expect((await a1.closed).code).toBe(CLOSE_REPLACED);
    // B sees the partner re-appear (so it re-offers), never peer-left.
    expect(await b.drain(150)).toEqual([{ type: 'peer-joined' }]);
    expect(relay.stats()).toEqual({ rooms: 1, sockets: 2, joined: 2 });

    // Signals now flow to the new socket.
    const envelope = { payload: '{"x":1}', mac: 'm' };
    b.send({ type: 'signal', envelope });
    expect(await a2.next()).toEqual({ type: 'signal', envelope });
  });

  it('replacement works when the device is alone in the room', async () => {
    const a1 = track(await joined(relay.url, ROOM, DEV_A));
    const a2 = track(await connect(relay.url));
    a2.send({ type: 'join', room: ROOM, deviceId: DEV_A });
    expect(await a2.next()).toEqual({ type: 'joined', peerPresent: false });
    expect((await a1.closed).code).toBe(CLOSE_REPLACED);
    await until(() => relay.stats().sockets === 1);
    expect(relay.stats()).toEqual({ rooms: 1, sockets: 1, joined: 1 });
  });

  it('rejects a second join on the same socket', async () => {
    const a = track(await joined(relay.url, ROOM, DEV_A));
    a.send({ type: 'join', room: ROOM2, deviceId: DEV_A });
    expect(await a.next()).toMatchObject({ type: 'error', code: 'bad-request' });
    expect(relay.stats().rooms).toBe(1);
  });
});

describe('signal forwarding', () => {
  it('forwards envelopes verbatim to the other peer only', async () => {
    const a = track(await joined(relay.url, ROOM, DEV_A));
    const b = track(await joined(relay.url, ROOM, DEV_B));
    await a.next(); // peer-joined

    const payload = '{"v":1,"from":"device-aaaa","nonce":"00ff","ts":1,"data":{"kind":"offer","sdp":"v=0\\r\\n  ünïcødé 🎉"}}';
    const envelope = { payload, mac: 'abc-_123' };
    a.send({ type: 'signal', envelope: { ...envelope, extra: 'dropped' } });
    const m = await b.next();
    expect(m).toEqual({ type: 'signal', envelope });
    expect(JSON.parse(b.raw.at(-1)!).envelope.payload).toBe(payload);
    expect(await a.drain(100)).toEqual([]); // no echo
  });

  it('drops signals when no peer is present', async () => {
    const a = track(await joined(relay.url, ROOM, DEV_A));
    a.send({ type: 'signal', envelope: { payload: 'p', mac: 'm' } });
    expect(await a.drain(100)).toEqual([]);
  });

  it('rejects signal from a socket that has not joined', async () => {
    const a = track(await connect(relay.url));
    a.send({ type: 'signal', envelope: { payload: 'p', mac: 'm' } });
    expect(await a.next()).toMatchObject({ type: 'error', code: 'not-joined' });
  });

  it('rejects oversized frames with too-large and keeps the socket', async () => {
    const a = track(await joined(relay.url, ROOM, DEV_A));
    const b = track(await joined(relay.url, ROOM, DEV_B));
    await a.next();
    a.send({ type: 'signal', envelope: { payload: 'x'.repeat(MAX_SIGNAL_BYTES), mac: 'm' } });
    expect(await a.next()).toMatchObject({ type: 'error', code: 'too-large' });
    expect(await b.drain(100)).toEqual([]);
    a.send({ type: 'ping' });
    expect(await a.next()).toEqual({ type: 'pong' });
  });

  it('accepts a frame right at the size limit', async () => {
    const a = track(await joined(relay.url, ROOM, DEV_A));
    const b = track(await joined(relay.url, ROOM, DEV_B));
    await a.next();
    const overhead = JSON.stringify({ type: 'signal', envelope: { payload: '', mac: 'm' } }).length;
    const payload = 'y'.repeat(MAX_SIGNAL_BYTES - overhead);
    a.send({ type: 'signal', envelope: { payload, mac: 'm' } });
    expect(await b.next()).toEqual({ type: 'signal', envelope: { payload, mac: 'm' } });
  });

  it('answers bad-request for invalid JSON, unknown types, bad ids and binary frames', async () => {
    const a = track(await connect(relay.url));
    const bad = [
      'not json',
      '[]',
      '"join"',
      JSON.stringify({ type: 'nope' }),
      JSON.stringify({ type: 'join', room: 'XYZ', deviceId: DEV_A }),
      JSON.stringify({ type: 'join', room: ROOM, deviceId: 'short' }),
      JSON.stringify({ type: 'signal', envelope: { payload: 1, mac: 'm' } }),
    ];
    for (const frame of bad) {
      a.sendRaw(frame);
      expect(await a.next(), frame).toMatchObject({ type: 'error', code: 'bad-request' });
    }
    a.sendRaw(Buffer.from(JSON.stringify({ type: 'ping' })));
    expect(await a.next()).toMatchObject({ type: 'error', code: 'bad-request' });
    expect(relay.stats().rooms).toBe(0);
  });
});

describe('heartbeat and limits', () => {
  it('answers ping with pong', async () => {
    const a = track(await connect(relay.url));
    a.send({ type: 'ping' });
    expect(await a.next()).toEqual({ type: 'pong' });
  });

  it('rate-limits a chatty socket', async () => {
    const a = track(await connect(relay.url));
    for (let i = 0; i < 70; i++) a.send({ type: 'ping' });
    const msgs = await a.drain(300);
    const pongs = msgs.filter((m) => m.type === 'pong').length;
    const limited = msgs.filter((m) => m.type === 'error' && m.code === 'rate-limited').length;
    expect(pongs).toBeGreaterThanOrEqual(50);
    expect(pongs).toBeLessThan(55);
    expect(limited).toBe(70 - pongs);
  });

  it('caps concurrent connections per IP', async () => {
    await relay.close();
    relay = await createRelay({ port: 0, maxConnectionsPerIp: 2 });
    track(await connect(relay.url));
    track(await connect(relay.url));
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl(relay.url));
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    expect(status).toBe(429);
    clients[0].close();
    await until(() => relay.stats().sockets === 1);
    track(await connect(relay.url)); // slot freed
  });

  it('terminates silent sockets and keeps responsive ones', async () => {
    await relay.close();
    relay = await createRelay({ port: 0, heartbeatMs: 40 });
    const silent = track(await connect(relay.url, { autoPong: false }));
    silent.send({ type: 'join', room: ROOM, deviceId: DEV_A });
    await silent.next();
    const alive = track(await joined(relay.url, ROOM, DEV_B)); // auto-pongs ws pings
    await silent.next(); // peer-joined
    await silent.closed;
    expect(await alive.next()).toEqual({ type: 'peer-left' });
    await new Promise((r) => setTimeout(r, 200));
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
    expect(relay.stats()).toEqual({ rooms: 1, sockets: 1, joined: 1 });
  });

  it('closes sockets that never join a room (R-10)', async () => {
    await relay.close();
    relay = await createRelay({ port: 0, heartbeatMs: 40, joinDeadlineMs: 60 });
    const idle = track(await connect(relay.url)); // answers pings, but never joins
    const member = track(await joined(relay.url, ROOM, DEV_A));
    await idle.closed;
    await new Promise((r) => setTimeout(r, 150));
    expect(member.ws.readyState).toBe(WebSocket.OPEN);
    expect(relay.stats()).toEqual({ rooms: 1, sockets: 1, joined: 1 });
  });

  it('refuses websocket upgrades on other paths', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(relay.url.replace(/^http/, 'ws') + '/proxy');
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => resolve(-1));
    });
    expect(status).toBe(404);
  });

  it('close() disconnects clients and leaves nothing behind', async () => {
    const a = track(await joined(relay.url, ROOM, DEV_A));
    await relay.close();
    await a.closed;
    expect(relay.stats()).toEqual({ rooms: 0, sockets: 0, joined: 0 });
  });
});
