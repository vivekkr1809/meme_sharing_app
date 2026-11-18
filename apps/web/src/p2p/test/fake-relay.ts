import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RelayToClient, SignedEnvelope } from '@memes/shared';
import { RELAY_WS_PATH, parseClientToRelay } from '@memes/shared';

/**
 * Minimal in-process relay implementing protocol.ts (join / forward / ping), with hooks
 * that let tests misbehave like a malicious or flaky relay would.
 */
export interface FakeRelayOptions {
  port?: number;
  /** Rewrite (or drop, by returning null) every forwarded envelope. */
  tamper?: (env: SignedEnvelope, fromDevice: string) => SignedEnvelope | null;
  /** When false the relay ignores pings (simulates a zombie connection). */
  answerPings?: boolean;
}

interface Client {
  ws: WebSocket;
  room?: string;
  deviceId?: string;
}

export interface FakeRelay {
  url: string;
  port: number;
  opts: FakeRelayOptions;
  /** Every envelope forwarded so far (after tampering). */
  forwarded: { from: string; envelope: SignedEnvelope }[];
  joins: string[];
  /** Device ids currently joined to `room`. */
  members(room: string): string[];
  /** Drop the relay socket of a device (the WebRTC link is untouched). */
  kick(deviceId: string): void;
  /** Send a raw frame to a device. */
  inject(deviceId: string, msg: RelayToClient | string): void;
  close(): Promise<void>;
}

export async function startFakeRelay(opts: FakeRelayOptions = {}): Promise<FakeRelay> {
  const http: Server = createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: req.url === '/health' }));
  });
  const wss = new WebSocketServer({ server: http, path: RELAY_WS_PATH });
  const rooms = new Map<string, Map<string, Client>>();
  const clients = new Set<Client>();
  const forwarded: FakeRelay['forwarded'] = [];
  const joins: string[] = [];

  const send = (c: Client, msg: RelayToClient | string) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  };
  const others = (c: Client) =>
    c.room ? [...(rooms.get(c.room)?.values() ?? [])].filter((o) => o !== c) : [];

  const leave = (c: Client) => {
    if (!c.room || !c.deviceId) return;
    const room = rooms.get(c.room);
    if (room?.get(c.deviceId) === c) {
      room.delete(c.deviceId);
      for (const o of room.values()) send(o, { type: 'peer-left' });
      if (room.size === 0) rooms.delete(c.room);
    }
    c.room = c.deviceId = undefined;
  };

  wss.on('connection', (ws) => {
    const c: Client = { ws };
    clients.add(c);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return send(c, { type: 'error', code: 'bad-request', message: 'binary' });
      const msg = parseClientToRelay(data.toString());
      if (!msg) return send(c, { type: 'error', code: 'bad-request', message: 'invalid' });
      switch (msg.type) {
        case 'ping':
          if (opts.answerPings !== false) send(c, { type: 'pong' });
          return;
        case 'join': {
          leave(c);
          let room = rooms.get(msg.room);
          if (!room) rooms.set(msg.room, (room = new Map()));
          const existing = room.get(msg.deviceId);
          if (!existing && room.size >= 2) {
            send(c, { type: 'error', code: 'room-full', message: 'room full' });
            return c.ws.close(4001, 'room full');
          }
          if (existing) {
            // Same device joined again: replace silently (no peer-left), close the old socket.
            existing.room = existing.deviceId = undefined;
            existing.ws.close(4000, 'replaced');
          }
          const peers = [...room.values()].filter((p) => p !== existing);
          room.set(msg.deviceId, c);
          c.room = msg.room;
          c.deviceId = msg.deviceId;
          joins.push(msg.deviceId);
          send(c, { type: 'joined', peerPresent: peers.length > 0 });
          for (const p of peers) send(p, { type: 'peer-joined' });
          return;
        }
        case 'signal': {
          if (!c.room) return send(c, { type: 'error', code: 'not-joined', message: 'join first' });
          const env = opts.tamper ? opts.tamper(msg.envelope, c.deviceId!) : msg.envelope;
          if (!env) return;
          forwarded.push({ from: c.deviceId!, envelope: env });
          for (const o of others(c)) send(o, { type: 'signal', envelope: env });
          return;
        }
      }
    });
    ws.on('close', () => {
      leave(c);
      clients.delete(c);
    });
  });

  await new Promise<void>((r) => http.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const find = (deviceId: string) => [...clients].filter((c) => c.deviceId === deviceId);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    opts,
    forwarded,
    joins,
    members: (room) => [...(rooms.get(room)?.keys() ?? [])],
    kick: (deviceId) => {
      for (const c of find(deviceId)) c.ws.terminate();
    },
    inject: (deviceId, msg) => {
      for (const c of find(deviceId)) send(c, msg);
    },
    close: async () => {
      for (const c of clients) c.ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
