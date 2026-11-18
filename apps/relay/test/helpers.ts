import { WebSocket } from 'ws';
import type { RelayToClient } from '@memes/shared';

export const ROOM = 'a'.repeat(32);
export const ROOM2 = 'b'.repeat(32);
export const DEV_A = 'device-aaaa';
export const DEV_B = 'device-bbbb';
export const DEV_C = 'device-cccc';

export interface TestClient {
  ws: WebSocket;
  /** Raw text frames received, in order. */
  raw: string[];
  send(msg: unknown): void;
  sendRaw(data: string | Buffer): void;
  /** Next message (waits up to `ms`). */
  next(ms?: number): Promise<RelayToClient>;
  /** Resolves with all messages received within `ms`. */
  drain(ms: number): Promise<RelayToClient[]>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

export function wsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws') + '/ws';
}

export async function connect(httpUrl: string, opts: { autoPong?: boolean } = {}): Promise<TestClient> {
  const ws = new WebSocket(wsUrl(httpUrl), { autoPong: opts.autoPong ?? true });
  const queue: RelayToClient[] = [];
  const waiters: ((m: RelayToClient) => void)[] = [];
  const raw: string[] = [];
  ws.on('message', (data) => {
    const text = data.toString();
    raw.push(text);
    const msg = JSON.parse(text) as RelayToClient;
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    raw,
    closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    sendRaw: (data) => ws.send(data),
    next: (ms = 2000) =>
      new Promise((resolve, reject) => {
        const m = queue.shift();
        if (m) return resolve(m);
        const t = setTimeout(() => {
          const i = waiters.indexOf(fn);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('timeout waiting for message'));
        }, ms);
        const fn = (msg: RelayToClient) => {
          clearTimeout(t);
          resolve(msg);
        };
        waiters.push(fn);
      }),
    drain: (ms) =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve(queue.splice(0));
        }, ms),
      ),
    close: () => ws.close(),
  };
}

export async function joined(httpUrl: string, room: string, deviceId: string): Promise<TestClient> {
  const c = await connect(httpUrl);
  c.send({ type: 'join', room, deviceId });
  const m = await c.next();
  if (m.type !== 'joined') throw new Error(`expected joined, got ${JSON.stringify(m)}`);
  return c;
}

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
