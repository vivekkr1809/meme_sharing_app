import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOB_CHUNK_BYTES, MAX_MEME_BYTES } from '@memes/shared';
import type { ChunkHeader, CompletedBlob } from '../framing';
import { chunkBlob, chunkCount, decodeBinary, encodeBinary, MAX_HEADER_BYTES, Reassembler } from '../framing';

const MEME = 'a'.repeat(64);

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) out[i] = x = (x * 1103515245 + 12345) & 0xff;
  return out;
}

function decodeAll(bufs: ArrayBuffer[]) {
  return bufs.map((b) => {
    const d = decodeBinary(b);
    if (!d || d.header.t !== 'chunk') throw new Error('bad chunk');
    return { h: d.header, p: d.payload };
  });
}

describe('binary framing', () => {
  it('round-trips header and payload', () => {
    const payload = bytes(1234);
    const buf = encodeBinary({ t: 'chunk', id: 'x1', memeId: MEME, mime: 'image/png', seq: 0, total: 1, size: 1234 }, payload);
    const d = decodeBinary(buf)!;
    expect(d.header).toEqual({ t: 'chunk', id: 'x1', memeId: MEME, mime: 'image/png', seq: 0, total: 1, size: 1234 });
    expect(Array.from(d.payload)).toEqual(Array.from(payload));
    expect(decodeBinary(encodeBinary({ t: 'ping', n: 7 }))).toEqual({ header: { t: 'ping', n: 7 }, payload: new Uint8Array(0) });
  });

  it('rejects malformed binary messages', () => {
    expect(decodeBinary(new ArrayBuffer(2))).toBeNull();
    const huge = new ArrayBuffer(8);
    new DataView(huge).setUint32(0, MAX_HEADER_BYTES + 1);
    expect(decodeBinary(huge)).toBeNull();
    const short = new ArrayBuffer(8);
    new DataView(short).setUint32(0, 100); // claims more than present
    expect(decodeBinary(short)).toBeNull();
    const notJson = new Uint8Array([0, 0, 0, 3, 0x7b, 0x7b, 0x7b]);
    expect(decodeBinary(notJson)).toBeNull();
    const enc = (o: unknown) => {
      const h = new TextEncoder().encode(JSON.stringify(o));
      const b = new Uint8Array(4 + h.length);
      new DataView(b.buffer).setUint32(0, h.length);
      b.set(h, 4);
      return b;
    };
    expect(decodeBinary(enc({ t: 'nope' }))).toBeNull();
    expect(decodeBinary(enc({ t: 'chunk', id: 'x', memeId: MEME, mime: 'image/png', seq: 0.5, total: 1, size: 1 }))).toBeNull();
    expect(decodeBinary(enc({ t: 'chunk', id: '', memeId: MEME, mime: 'image/png', seq: 0, total: 1, size: 1 }))).toBeNull();
    expect(decodeBinary(enc({ t: 'ping', n: 'x' }))).toBeNull();
  });

  it('chunks into ≤ BLOB_CHUNK_BYTES payloads', () => {
    const data = bytes(BLOB_CHUNK_BYTES * 3 + 5);
    const chunks = decodeAll([...chunkBlob('t', MEME, 'image/gif', data)]);
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.p.byteLength)).toEqual([BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES, 5]);
    expect(chunks.every((c) => c.h.total === 4 && c.h.size === data.byteLength)).toBe(true);
    expect(chunkCount(BLOB_CHUNK_BYTES)).toBe(1);
    expect(chunkCount(BLOB_CHUNK_BYTES + 1)).toBe(2);
  });
});

describe('Reassembler', () => {
  afterEach(() => vi.useRealTimers());

  function setup(opts: Partial<ConstructorParameters<typeof Reassembler>[0]> = {}) {
    const done: CompletedBlob[] = [];
    const drops: string[] = [];
    const r = new Reassembler({ onComplete: (b) => done.push(b), onDrop: (_id, why) => drops.push(why), ...opts });
    return { r, done, drops };
  }

  it('reassembles a multi-chunk blob exactly', () => {
    const { r, done } = setup();
    const data = bytes(200_000, 9);
    for (const { h, p } of decodeAll([...chunkBlob('t1', MEME, 'image/webp', data)])) r.push(h, p);
    expect(done).toHaveLength(1);
    expect(done[0]!.memeId).toBe(MEME);
    expect(done[0]!.mime).toBe('image/webp');
    expect(Buffer.from(done[0]!.data).equals(Buffer.from(data))).toBe(true);
    expect(r.inFlight).toBe(0);
  });

  it('handles two transfers of different ids independently', () => {
    const { r, done } = setup();
    const a = decodeAll([...chunkBlob('a', MEME, 'image/png', bytes(40_000, 1))]);
    const b = decodeAll([...chunkBlob('b', 'b'.repeat(64), 'image/png', bytes(40_000, 2))]);
    for (let i = 0; i < a.length; i++) {
      r.push(a[i]!.h, a[i]!.p);
      r.push(b[i]!.h, b[i]!.p);
    }
    expect(done.map((d) => d.memeId)).toEqual([MEME, 'b'.repeat(64)]);
  });

  it('rejects blobs above MAX_MEME_BYTES before allocating', () => {
    const { r, done, drops } = setup();
    const size = MAX_MEME_BYTES + 1;
    r.push({ t: 'chunk', id: 'big', memeId: MEME, mime: 'image/png', seq: 0, total: chunkCount(size), size }, bytes(BLOB_CHUNK_BYTES));
    expect(drops).toEqual(['size']);
    expect(r.inFlight).toBe(0);
    expect(done).toHaveLength(0);
  });

  it('enforces a custom maxBytes', () => {
    const { r, drops } = setup({ maxBytes: 1000 });
    const [c] = decodeAll([...chunkBlob('t', MEME, 'image/png', bytes(1001))]);
    r.push(c!.h, c!.p);
    expect(drops).toEqual(['size']);
  });

  it('rejects insane totals, wrong lengths, gaps and header changes', () => {
    const base: ChunkHeader = { t: 'chunk', id: 'x', memeId: MEME, mime: 'image/png', seq: 0, total: 3, size: 3 * BLOB_CHUNK_BYTES };
    const full = bytes(BLOB_CHUNK_BYTES);

    let s = setup();
    s.r.push({ ...base, total: 1_000_000 }, full);
    expect(s.drops).toEqual(['total']);

    s = setup();
    s.r.push({ ...base, size: 0, total: 0 }, new Uint8Array());
    expect(s.drops).toEqual(['size']);

    s = setup();
    s.r.push(base, bytes(10));
    expect(s.drops).toEqual(['length']);

    s = setup();
    s.r.push(base, full);
    s.r.push({ ...base, seq: 2 }, full);
    expect(s.drops).toEqual(['order']);
    s.r.push({ ...base, seq: 1 }, full); // tail of a dropped transfer is ignored
    expect(s.r.inFlight).toBe(0);

    s = setup();
    s.r.push(base, full);
    s.r.push({ ...base, seq: 1, mime: 'image/gif' }, full);
    expect(s.drops).toEqual(['inconsistent']);

    s = setup();
    s.r.push({ ...base, seq: 1 }, full); // starts mid-way → ignored
    expect(s.r.inFlight).toBe(0);
    expect(s.done).toHaveLength(0);
  });

  it('times out an incomplete transfer after inactivity', () => {
    vi.useFakeTimers();
    const { r, done, drops } = setup({ timeoutMs: 60_000 });
    const chunks = decodeAll([...chunkBlob('t', MEME, 'image/png', bytes(BLOB_CHUNK_BYTES * 3))]);
    r.push(chunks[0]!.h, chunks[0]!.p);
    vi.advanceTimersByTime(59_000);
    r.push(chunks[1]!.h, chunks[1]!.p); // activity resets the timer
    vi.advanceTimersByTime(59_000);
    expect(r.inFlight).toBe(1);
    vi.advanceTimersByTime(1_001);
    expect(drops).toEqual(['timeout']);
    expect(r.inFlight).toBe(0);
    r.push(chunks[2]!.h, chunks[2]!.p);
    expect(done).toHaveLength(0);
  });

  it('caps concurrent transfers and resets cleanly', () => {
    const { r, drops } = setup({ maxConcurrent: 2 });
    const first = (id: string) => decodeAll([...chunkBlob(id, MEME, 'image/png', bytes(BLOB_CHUNK_BYTES * 2))])[0]!;
    for (const id of ['a', 'b', 'c']) {
      const c = first(id);
      r.push(c.h, c.p);
    }
    expect(drops).toEqual(['concurrency']);
    expect(r.inFlight).toBe(2);
    r.reset();
    expect(r.inFlight).toBe(0);
    expect(drops).toEqual(['concurrency', 'reset', 'reset']);
  });
});
