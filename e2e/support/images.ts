import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

/**
 * Deterministic test images, generated in-process (no fixtures on disk, no internet).
 * Every image gets a distinct pattern so sha256 ids never collide between fixtures.
 */

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A width×height RGB PNG with a colour gradient seeded by `seed`. */
export function makePng(width: number, height: number, seed: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o++] = (x * 7 + seed * 53) & 0xff;
      raw[o++] = (y * 5 + seed * 97) & 0xff;
      raw[o++] = ((x ^ y) + seed * 31) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * Substrings that would show up if `bytes` leaked into a text channel
 * (hex, base64 and base64url at every alignment). Used by the privacy checks.
 */
export function leakSignatures(bytes: Uint8Array, samples = 4): string[] {
  const buf = Buffer.from(bytes);
  const out: string[] = [];
  const span = 48;
  for (let i = 0; i < samples; i++) {
    const off = Math.floor(((buf.length - span - 3) * (i + 1)) / (samples + 1));
    out.push(buf.subarray(off, off + 24).toString('hex'));
    for (let shift = 0; shift < 3; shift++) {
      const b64 = buf.subarray(off + shift, off + shift + span).toString('base64');
      const inner = b64.slice(4, -4); // drop edge chars that depend on neighbours
      out.push(inner, inner.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  return out;
}
