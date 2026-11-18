import { fromBase64Url, randomBytes, toBase64Url } from './crypto';

/**
 * Password-based encryption shared by the passcode lock and encrypted backups.
 * WebCrypto only: PBKDF2-SHA256 → AES-GCM-256.
 *
 * Strength depends on the password. PBKDF2 slows guessing, but a 4–6 digit PIN can still be
 * brute-forced offline by someone who copies the encrypted data, so the UI should encourage
 * longer passcodes for backups (which may be stored anywhere).
 */

/** OWASP 2023 recommendation for PBKDF2-HMAC-SHA256. ~0.3–1.5 s on phones. */
export const PBKDF2_ITERATIONS = 600_000;
/** Lower bound accepted when reading params from untrusted data (backups, stored lock records). */
export const PBKDF2_MIN_ITERATIONS = 100_000;
/** Upper bound, so a crafted file can't make the app spin for minutes. */
export const PBKDF2_MAX_ITERATIONS = 5_000_000;

export interface PasswordKdfParams {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  /** base64url, 16 random bytes. */
  salt: string;
}

/** AES-GCM ciphertext: base64url IV (12 bytes) + base64url ciphertext-with-tag. */
export interface SealedBox {
  iv: string;
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

function buf(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(data.byteLength));
  out.set(data);
  return out;
}

export function newKdfParams(iterations: number = PBKDF2_ITERATIONS): PasswordKdfParams {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64Url(randomBytes(16)) };
}

/** Validate KDF params from untrusted input. Tests may pass a lower `minIterations`. */
export function isKdfParams(x: unknown, minIterations = PBKDF2_MIN_ITERATIONS): x is PasswordKdfParams {
  const p = x as PasswordKdfParams;
  return (
    !!p &&
    p.name === 'PBKDF2' &&
    p.hash === 'SHA-256' &&
    Number.isInteger(p.iterations) &&
    p.iterations >= minIterations &&
    p.iterations <= PBKDF2_MAX_ITERATIONS &&
    typeof p.salt === 'string' &&
    /^[A-Za-z0-9_-]{16,64}$/.test(p.salt)
  );
}

export function isSealedBox(x: unknown): x is SealedBox {
  const b = x as SealedBox;
  return !!b && typeof b.iv === 'string' && typeof b.ct === 'string' && /^[A-Za-z0-9_-]{16}$/.test(b.iv);
}

/** Passwords are NFKC-normalized so the same passphrase typed on iOS and Android matches. */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/** Derive a non-extractable AES-GCM-256 key from a password. */
export async function deriveKeyFromPassword(password: string, params: PasswordKdfParams): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', buf(enc.encode(normalizePassword(password))), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: params.iterations, salt: buf(fromBase64Url(params.salt)) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Generate a random AES-GCM-256 data key. `extractable` is needed only to wrap (seal) it. */
export function generateDataKey(extractable = true): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey('raw', key));
}

export function importRawKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(raw), { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

/** Encrypt with a fresh random IV. `aad` binds context (e.g. "backup-v1"), and must match on open. */
export async function seal(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<SealedBox> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, ...(aad ? { additionalData: buf(aad) } : {}) },
    key,
    buf(plaintext),
  );
  return { iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

/** Decrypt. Throws Error('decrypt-failed') on a wrong key, tampering, or malformed input. */
export async function unseal(key: CryptoKey, box: SealedBox, aad?: Uint8Array): Promise<Uint8Array> {
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(box.iv), ...(aad ? { additionalData: buf(aad) } : {}) },
      key,
      fromBase64Url(box.ct),
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error('decrypt-failed');
  }
}

export async function sealString(key: CryptoKey, text: string, aad?: string): Promise<SealedBox> {
  return seal(key, enc.encode(text), aad === undefined ? undefined : enc.encode(aad));
}

export async function unsealString(key: CryptoKey, box: SealedBox, aad?: string): Promise<string> {
  return dec.decode(await unseal(key, box, aad === undefined ? undefined : enc.encode(aad)));
}
