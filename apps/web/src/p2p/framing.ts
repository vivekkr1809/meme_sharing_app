import { BLOB_CHUNK_BYTES, MAX_MEME_BYTES } from '@memes/shared';

/**
 * Binary DataChannel framing (text messages are ControlFrame JSON and are not handled here).
 *
 *   [u32 BE header length][UTF-8 JSON header][payload bytes]
 *
 * Header kinds:
 *   chunk — one piece of a blob transfer; payload ≤ BLOB_CHUNK_BYTES
 *   ping / pong — transport-internal liveness probe (no payload)
 */

export interface ChunkHeader {
  t: 'chunk';
  /** Transfer id (random per sendBlob call). */
  id: string;
  memeId: string;
  mime: string;
  seq: number;
  total: number;
  size: number;
}
export interface PingHeader {
  t: 'ping' | 'pong';
  n: number;
}
export type BinaryHeader = ChunkHeader | PingHeader;

export interface DecodedBinary {
  header: BinaryHeader;
  payload: Uint8Array;
}

export const MAX_HEADER_BYTES = 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeBinary(header: BinaryHeader, payload?: Uint8Array): ArrayBuffer {
  const h = enc.encode(JSON.stringify(header));
  if (h.byteLength > MAX_HEADER_BYTES) throw new Error('header too large');
  const plen = payload?.byteLength ?? 0;
  const buf = new ArrayBuffer(4 + h.byteLength + plen);
  new DataView(buf).setUint32(0, h.byteLength);
  const u8 = new Uint8Array(buf);
  u8.set(h, 4);
  if (payload) u8.set(payload, 4 + h.byteLength);
  return buf;
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isShortStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;

function validHeader(x: unknown): BinaryHeader | null {
  if (typeof x !== 'object' || x === null) return null;
  const h = x as Record<string, unknown>;
  if (h.t === 'ping' || h.t === 'pong') return isInt(h.n) ? { t: h.t, n: h.n } : null;
  if (h.t !== 'chunk') return null;
  if (!isShortStr(h.id, 64) || !isShortStr(h.memeId, 128) || !isShortStr(h.mime, 128)) return null;
  if (!isInt(h.seq) || !isInt(h.total) || !isInt(h.size)) return null;
  return { t: 'chunk', id: h.id, memeId: h.memeId, mime: h.mime, seq: h.seq, total: h.total, size: h.size };
}

/** Parse a binary DataChannel message. Returns null for anything malformed. */
export function decodeBinary(data: ArrayBuffer | Uint8Array): DecodedBinary | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteLength < 4) return null;
  const hlen = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0);
  if (hlen === 0 || hlen > MAX_HEADER_BYTES || 4 + hlen > u8.byteLength) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(u8.subarray(4, 4 + hlen)));
  } catch {
    return null;
  }
  const header = validHeader(parsed);
  if (!header) return null;
  return { header, payload: u8.subarray(4 + hlen) };
}

export function chunkCount(size: number, chunkBytes = BLOB_CHUNK_BYTES): number {
  return Math.ceil(size / chunkBytes);
}

/** Split a blob into encoded chunk messages (lazily). */
export function* chunkBlob(
  id: string,
  memeId: string,
  mime: string,
  data: Uint8Array,
  chunkBytes = BLOB_CHUNK_BYTES,
): Generator<ArrayBuffer> {
  const size = data.byteLength;
  const total = chunkCount(size, chunkBytes);
  for (let seq = 0; seq < total; seq++) {
    const payload = data.subarray(seq * chunkBytes, Math.min(size, (seq + 1) * chunkBytes));
    yield encodeBinary({ t: 'chunk', id, memeId, mime, seq, total, size }, payload);
  }
}

export interface CompletedBlob {
  memeId: string;
  mime: string;
  data: Uint8Array;
}

export interface ReassemblerOptions {
  onComplete: (blob: CompletedBlob) => void;
  /** Called when a transfer is abandoned (bad chunk, timeout, limit). */
  onDrop?: (id: string, reason: string) => void;
  maxBytes?: number;
  chunkBytes?: number;
  /** Drop a transfer after this long without a new chunk. */
  timeoutMs?: number;
  /** Max simultaneous incomplete transfers; the oldest is dropped beyond this. */
  maxConcurrent?: number;
}

interface Pending {
  h: ChunkHeader;
  buf: Uint8Array;
  next: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Receiver side of blob transfers. Chunks must arrive in order (the DataChannel is ordered);
 * any inconsistency drops the transfer rather than emitting corrupt data.
 */
export class Reassembler {
  private pending = new Map<string, Pending>();
  private readonly maxBytes: number;
  private readonly chunkBytes: number;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;

  constructor(private opts: ReassemblerOptions) {
    this.maxBytes = opts.maxBytes ?? MAX_MEME_BYTES;
    this.chunkBytes = opts.chunkBytes ?? BLOB_CHUNK_BYTES;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  push(h: ChunkHeader, payload: Uint8Array): void {
    let p = this.pending.get(h.id);
    if (!p) {
      if (h.seq !== 0) return; // tail of a transfer we already dropped
      if (h.size < 1 || h.size > this.maxBytes) return this.opts.onDrop?.(h.id, 'size');
      if (h.total !== chunkCount(h.size, this.chunkBytes)) return this.opts.onDrop?.(h.id, 'total');
      while (this.pending.size >= this.maxConcurrent) {
        const oldest = this.pending.keys().next().value as string;
        this.drop(oldest, 'concurrency');
      }
      p = { h, buf: new Uint8Array(h.size), next: 0, timer: this.arm(h.id) };
      this.pending.set(h.id, p);
    } else {
      clearTimeout(p.timer);
      p.timer = this.arm(h.id);
    }
    const ref = p.h;
    if (h.memeId !== ref.memeId || h.mime !== ref.mime || h.size !== ref.size || h.total !== ref.total) {
      return this.drop(h.id, 'inconsistent');
    }
    if (h.seq !== p.next) return this.drop(h.id, 'order');
    const offset = h.seq * this.chunkBytes;
    const expected = Math.min(this.chunkBytes, ref.size - offset);
    if (payload.byteLength !== expected) return this.drop(h.id, 'length');
    p.buf.set(payload, offset);
    p.next++;
    if (p.next === ref.total) {
      clearTimeout(p.timer);
      this.pending.delete(h.id);
      this.opts.onComplete({ memeId: ref.memeId, mime: ref.mime, data: p.buf });
    }
  }

  /** Abandon everything (e.g. the channel closed). */
  reset(): void {
    for (const id of [...this.pending.keys()]) this.drop(id, 'reset');
  }

  private arm(id: string) {
    return setTimeout(() => this.drop(id, 'timeout'), this.timeoutMs);
  }

  private drop(id: string, reason: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.opts.onDrop?.(id, reason);
  }
}
