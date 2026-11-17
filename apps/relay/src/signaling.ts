import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  HEARTBEAT_MS,
  MAX_SIGNAL_BYTES,
  parseClientToRelay,
  type RelayErrorCode,
  type RelayToClient,
} from '@memes/shared';

/**
 * In-memory signaling rooms. Nothing here is ever written to disk or logged:
 * room ids, device ids, envelopes and IP addresses stay in RAM for the
 * lifetime of a socket and are dropped as soon as it closes.
 *
 * Room semantics
 * ──────────────
 * - A room is created by the first `join` and deleted the moment its last
 *   socket leaves. It holds at most two sockets, keyed by deviceId.
 * - `join` replies `joined{peerPresent}` to the joiner, then sends
 *   `peer-joined` to the other socket (if any). Per the negotiation rule in
 *   the shared protocol, the socket that receives `peer-joined` makes the offer.
 * - A third distinct deviceId gets `error room-full` and is closed (4001).
 * - Same-device replacement: if the joining deviceId already has a socket in
 *   the room (e.g. the app reloaded before the old TCP connection timed out),
 *   the old socket is detached from the room silently and closed with 4000
 *   "replaced". The other peer does NOT get `peer-left`; it gets `peer-joined`
 *   again, which means "your partner (re)appeared: tear down any existing
 *   RTCPeerConnection and make a fresh offer". The new socket's `joined` has
 *   peerPresent=true, so it waits for that offer.
 * - When a joined socket closes for any other reason, the remaining peer gets
 *   `peer-left`.
 * - A socket may join only once; a second `join` on the same socket is a
 *   `bad-request` (reconnect to switch rooms).
 * - `signal` is only accepted from joined sockets (`not-joined` otherwise) and
 *   is forwarded to the other socket with `payload` and `mac` copied verbatim
 *   (any extra fields are dropped). If no peer is present it is dropped.
 */

export const CLOSE_REPLACED = 4000;
export const CLOSE_ROOM_FULL = 4001;
export const CLOSE_ABUSE = 1008;
export const CLOSE_SHUTDOWN = 1001;

/** Hard frame limit enforced by ws itself (closes with 1009). Frames between
 * MAX_SIGNAL_BYTES and this size get a polite `too-large` error instead. */
const WS_MAX_PAYLOAD = MAX_SIGNAL_BYTES * 4;
/** Close sockets that keep hammering after being rate limited. */
const MAX_RATE_VIOLATIONS = 200;

export interface SignalingOptions {
  heartbeatMs?: number;
  /** Token bucket: burst capacity and refill window (capacity tokens per windowMs). */
  rateLimit?: { capacity: number; windowMs: number };
  maxConnectionsPerIp?: number;
  maxConnections?: number;
  /** Use the last X-Forwarded-For hop as the client IP (only behind a trusted reverse proxy). */
  trustProxy?: boolean;
  log: (msg: string) => void;
}

export interface SignalingStats {
  rooms: number;
  sockets: number;
  joined: number;
}

interface Client {
  ws: WebSocket;
  ip: string;
  room?: Room;
  deviceId?: string;
  tokens: number;
  lastRefill: number;
  lastSeen: number;
  violations: number;
}

interface Room {
  id: string;
  members: Map<string, Client>;
}

export class Signaling {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly rooms = new Map<string, Room>();
  private readonly perIp = new Map<string, number>();
  private readonly heartbeatMs: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxPerIp: number;
  private readonly maxConnections: number;
  private readonly trustProxy: boolean;
  private readonly log: (msg: string) => void;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(opts: SignalingOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.capacity = opts.rateLimit?.capacity ?? 50;
    this.refillPerMs = this.capacity / (opts.rateLimit?.windowMs ?? 10_000);
    this.maxPerIp = opts.maxConnectionsPerIp ?? 20;
    this.maxConnections = opts.maxConnections ?? 2000;
    this.trustProxy = opts.trustProxy ?? false;
    this.log = opts.log;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
    this.sweepTimer = setInterval(() => this.sweep(), this.heartbeatMs);
    this.sweepTimer.unref();
  }

  stats(): SignalingStats {
    let joined = 0;
    for (const c of this.clients) if (c.room) joined++;
    return { rooms: this.rooms.size, sockets: this.clients.size, joined };
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = this.clientIp(req);
    if (this.clients.size >= this.maxConnections || (this.perIp.get(ip) ?? 0) >= this.maxPerIp) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const c of this.clients) c.ws.close(CLOSE_SHUTDOWN, 'shutting down');
    // Give sockets a moment to close cleanly, then force.
    await new Promise((r) => setTimeout(r, 50));
    for (const c of this.clients) c.ws.terminate();
    for (let i = 0; i < 50 && this.clients.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
    // Anything still listed is gone at the TCP level; drop its in-memory state.
    for (const c of [...this.clients]) this.onClose(c);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private clientIp(req: IncomingMessage): string {
    if (this.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const value = Array.isArray(xff) ? xff[xff.length - 1] : xff;
      const last = value?.split(',').pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const now = Date.now();
    const client: Client = { ws, ip, tokens: this.capacity, lastRefill: now, lastSeen: now, violations: 0 };
    this.clients.add(client);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    this.logCounts('open');

    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('pong', () => {
      client.lastSeen = Date.now();
    });
    ws.on('error', () => {
      /* swallow: 'close' follows */
    });
    ws.on('close', () => this.onClose(client));
  }

  private onClose(client: Client): void {
    if (!this.clients.delete(client)) return;
    const n = (this.perIp.get(client.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(client.ip);
    else this.perIp.set(client.ip, n);

    const room = client.room;
    if (room && client.deviceId && room.members.get(client.deviceId) === client) {
      room.members.delete(client.deviceId);
      for (const other of room.members.values()) send(other.ws, { type: 'peer-left' });
      if (room.members.size === 0) this.rooms.delete(room.id);
    }
    client.room = undefined;
    this.logCounts('close');
  }

  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    client.lastSeen = Date.now();
    if (!this.takeToken(client)) {
      client.violations++;
      if (client.violations > MAX_RATE_VIOLATIONS) {
        client.ws.close(CLOSE_ABUSE, 'rate limit abuse');
        return;
      }
      return sendError(client.ws, 'rate-limited', 'Too many messages; slow down');
    }
    client.violations = 0;

    const size = rawSize(data);
    if (size > MAX_SIGNAL_BYTES) return sendError(client.ws, 'too-large', `Frame exceeds ${MAX_SIGNAL_BYTES} bytes`);
    if (isBinary) return sendError(client.ws, 'bad-request', 'Binary frames are not accepted');

    const msg = parseClientToRelay(rawToString(data));
    if (!msg) return sendError(client.ws, 'bad-request', 'Malformed or unknown message');

    switch (msg.type) {
      case 'ping':
        send(client.ws, { type: 'pong' });
        return;
      case 'join':
        this.join(client, msg.room, msg.deviceId);
        return;
      case 'signal': {
        const room = client.room;
        if (!room || !client.deviceId) return sendError(client.ws, 'not-joined', 'Join a room first');
        for (const [id, other] of room.members) {
          if (id !== client.deviceId) {
            send(other.ws, { type: 'signal', envelope: { payload: msg.envelope.payload, mac: msg.envelope.mac } });
          }
        }
        return;
      }
    }
  }

  private join(client: Client, roomId: string, deviceId: string): void {
    if (client.room) return sendError(client.ws, 'bad-request', 'Already joined');

    let room = this.rooms.get(roomId);
    const previous = room?.members.get(deviceId);
    if (room && !previous && room.members.size >= 2) {
      sendError(client.ws, 'room-full', 'Room already has two devices');
      client.ws.close(CLOSE_ROOM_FULL, 'room full');
      return;
    }
    if (!room) {
      room = { id: roomId, members: new Map() };
      this.rooms.set(roomId, room);
    }

    if (previous) {
      // Detach first so its close handler does not emit peer-left.
      previous.room = undefined;
      previous.deviceId = undefined;
      room.members.delete(deviceId);
      previous.ws.close(CLOSE_REPLACED, 'replaced');
    }

    const others = [...room.members.values()];
    room.members.set(deviceId, client);
    client.room = room;
    client.deviceId = deviceId;

    send(client.ws, { type: 'joined', peerPresent: others.length > 0 });
    for (const other of others) send(other.ws, { type: 'peer-joined' });
    this.logCounts('join');
  }

  private takeToken(client: Client): boolean {
    const now = Date.now();
    client.tokens = Math.min(this.capacity, client.tokens + (now - client.lastRefill) * this.refillPerMs);
    client.lastRefill = now;
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }

  private sweep(): void {
    const deadline = Date.now() - this.heartbeatMs * 3;
    for (const c of this.clients) {
      if (c.lastSeen < deadline) {
        c.ws.terminate();
        continue;
      }
      if (c.ws.readyState === WebSocket.OPEN) {
        try {
          c.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }
  }

  private logCounts(event: string): void {
    const s = this.stats();
    this.log(`ws ${event} rooms=${s.rooms} sockets=${s.sockets}`);
  }
}

function send(ws: WebSocket, msg: RelayToClient): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket, code: RelayErrorCode, message: string): void {
  send(ws, { type: 'error', code, message });
}

function rawSize(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data.byteLength;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
