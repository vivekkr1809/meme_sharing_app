/**
 * Test helpers for the data layer (not used by the app).
 * Callers must `import 'fake-indexeddb/auto'` before using these in Node.
 */
import type { Transport, TransportOptions } from '../contracts';
import { createLoopbackPair, type LoopbackTransport } from '../testing/loopback';
import { MemesDB } from '../db/schema';
import { createDataServices, type EngineTuning } from './index';
import type { Engine } from './engine';

let counter = 0;
export function uniqueDbName(tag = 'db'): string {
  return `memes-test-${tag}-${Date.now().toString(36)}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(3);
  }
}

export interface Device {
  svc: Engine;
  dbName: string;
  transport: LoopbackTransport;
  calls: TransportOptions[];
}

export async function openDevice(
  transport: LoopbackTransport,
  dbName = uniqueDbName(),
  tuning: EngineTuning = {},
  calls: TransportOptions[] = [],
): Promise<Device> {
  const svc = (await createDataServices({
    dbName,
    defaultRelayUrl: 'http://relay.test',
    createTransport: (o): Transport => {
      calls.push(o);
      return transport;
    },
    typingExpiryMs: 80,
    ...tuning,
  })) as Engine;
  return { svc, dbName, transport, calls };
}

/** Two onboarded devices, A created the pairing and B accepted it. Linked unless `linked: false`. */
export async function pairedDevices(opts: { linked?: boolean; tuning?: EngineTuning } = {}) {
  const loop = createLoopbackPair();
  const A = await openDevice(loop.a, uniqueDbName('a'), opts.tuning);
  const B = await openDevice(loop.b, uniqueDbName('b'), opts.tuning);
  await A.svc.pairing.setDisplayName('Alice');
  await B.svc.pairing.setDisplayName('Bob');
  const code = await A.svc.pairing.createPairing();
  await B.svc.pairing.acceptPairing(code);
  if (opts.linked !== false) loop.link();
  await settle([A, B]);
  return { A, B, loop, code };
}

/** Wait until both engines are idle and no frames/blobs are in flight for a few ticks. */
export async function settle(devices: Device[], maxMs = 5000): Promise<void> {
  const snap = () => devices.map((d) => `${d.svc.opCount}:${d.transport.sent.length}`).join('|');
  const until = Date.now() + maxMs;
  let stable = 0;
  while (stable < 3) {
    if (Date.now() > until) throw new Error('settle timed out');
    const before = snap();
    await Promise.all(devices.map((d) => d.svc.whenIdle()));
    await sleep(2);
    stable = snap() === before ? stable + 1 : 0;
  }
}

/** Read a device's raw DB (separate connection) for assertions. */
export async function rawDb<T>(dbName: string, fn: (db: MemesDB) => Promise<T>): Promise<T> {
  const db = new MemesDB(dbName);
  try {
    await db.open();
    return await fn(db);
  } finally {
    db.close();
  }
}

export function randomImage(size = 2048, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size));
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Deterministic PRNG for randomized tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
