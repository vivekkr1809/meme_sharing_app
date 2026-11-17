import type { SignalData, SignalPayload, SignedEnvelope } from './protocol';
import { SIGNAL_MAX_SKEW_MS } from './protocol';

/**
 * Pairing + signaling crypto. Uses only WebCrypto (available in browsers and Node >= 20).
 *
 *   secret (20 random bytes, shared once via QR / typed code)
 *     ├─ HKDF(info="room") → roomId (16 bytes hex)  — the only thing the relay sees
 *     └─ HKDF(info="auth") → HMAC-SHA256 key         — signs every SDP/ICE message so a
 *                                                     malicious relay can't MITM DTLS
 */

export const PAIRING_SECRET_BYTES = 20;
const HKDF_SALT = 'memes-v1';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

/** Copy into a fresh ArrayBuffer-backed view (keeps WebCrypto typings happy). */
function bytes(data: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const src = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function toHex(data: Uint8Array | ArrayBuffer): string {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Random hex id (default 16 bytes = 32 hex chars). Suitable for deviceIds and nonces. */
export function randomId(nBytes = 16): string {
  return toHex(randomBytes(nBytes));
}

export function toBase64Url(data: Uint8Array | ArrayBuffer): string {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function generatePairingSecret(): Uint8Array<ArrayBuffer> {
  return randomBytes(PAIRING_SECRET_BYTES);
}

/** Crockford base32, grouped in fours: "7K2M-QX9D-...". 20 bytes → 32 chars → 8 groups. */
export function encodePairingCode(secret: Uint8Array): string {
  if (secret.length !== PAIRING_SECRET_BYTES) throw new Error('bad secret length');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** Lenient decode: ignores case, spaces and dashes; maps I/L→1, O→0. Returns null if invalid. */
export function decodePairingCode(code: string): Uint8Array<ArrayBuffer> | null {
  const clean = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (clean.length !== 32) return null;
  const out = new Uint8Array(new ArrayBuffer(PAIRING_SECRET_BYTES));
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[idx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return idx === PAIRING_SECRET_BYTES ? out : null;
}

export interface PairingKeys {
  /** Opaque relay room id (32 hex chars). */
  roomId: string;
  /** HMAC-SHA256 key for signing signaling envelopes. */
  authKey: CryptoKey;
}

export async function deriveKeys(secret: Uint8Array): Promise<PairingKeys> {
  const base = await subtle().importKey('raw', bytes(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (info: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: bytes(enc.encode(HKDF_SALT)),
    info: bytes(enc.encode(info)),
  });
  const roomBits = await subtle().deriveBits(params('room'), base, 128);
  const authKey = await subtle().deriveKey(
    params('auth'),
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
  return { roomId: toHex(roomBits), authKey };
}

export async function signSignal(keys: PairingKeys, from: string, data: SignalData): Promise<SignedEnvelope> {
  const payload: SignalPayload = { v: 1, from, nonce: randomId(12), ts: Date.now(), data };
  const json = JSON.stringify(payload);
  const mac = await subtle().sign('HMAC', keys.authKey, bytes(enc.encode(json)));
  return { payload: json, mac: toBase64Url(mac) };
}

export interface OpenSignalOptions {
  now?: number;
  maxSkewMs?: number;
  /** Nonces already accepted; the nonce is added on success. Pass a long-lived Set for replay protection. */
  seenNonces?: Set<string>;
}

/** Verify + parse a signed envelope. Returns null if the MAC, timestamp, nonce or shape is invalid. */
export async function openSignal(
  keys: PairingKeys,
  env: SignedEnvelope,
  opts: OpenSignalOptions = {},
): Promise<SignalPayload | null> {
  if (!env || typeof env.payload !== 'string' || typeof env.mac !== 'string') return null;
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64Url(env.mac);
  } catch {
    return null;
  }
  const ok = await subtle().verify('HMAC', keys.authKey, mac, bytes(enc.encode(env.payload)));
  if (!ok) return null;
  let p: SignalPayload;
  try {
    p = JSON.parse(env.payload);
  } catch {
    return null;
  }
  if (p?.v !== 1 || typeof p.from !== 'string' || typeof p.nonce !== 'string' || typeof p.ts !== 'number') {
    return null;
  }
  const d = p.data as SignalData | undefined;
  const validData =
    !!d &&
    (((d.kind === 'offer' || d.kind === 'answer') && typeof d.sdp === 'string') ||
      (d.kind === 'ice' && typeof d.candidate?.candidate === 'string'));
  if (!validData) return null;
  const now = opts.now ?? Date.now();
  if (Math.abs(now - p.ts) > (opts.maxSkewMs ?? SIGNAL_MAX_SKEW_MS)) return null;
  if (opts.seenNonces) {
    if (opts.seenNonces.has(p.nonce)) return null;
    opts.seenNonces.add(p.nonce);
  }
  return p;
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  return toHex(await subtle().digest('SHA-256', bytes(data)));
}
