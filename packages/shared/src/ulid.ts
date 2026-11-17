/**
 * Monotonic ULID generator (https://github.com/ulid/spec).
 * 26 chars Crockford base32: 10 chars of ms timestamp + 16 chars randomness.
 * Lexicographic order == creation order (within a device; across devices by clock).
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let s = '';
  for (let i = 0; i < 10; i++) {
    s = ALPHABET[ms % 32] + s;
    ms = Math.floor(ms / 32);
  }
  return s;
}

function freshRandom(): number[] {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x & 31);
}

function increment(r: number[]): number[] {
  const out = r.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 31) {
      out[i]!++;
      return out;
    }
    out[i] = 0;
  }
  throw new Error('ULID random overflow');
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = increment(lastRandom);
    now = lastTime;
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(now) + lastRandom.map((x) => ALPHABET[x]).join('');
}

export function ulidTime(id: string): number {
  let ms = 0;
  for (const ch of id.slice(0, 10)) ms = ms * 32 + ALPHABET.indexOf(ch);
  return ms;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
