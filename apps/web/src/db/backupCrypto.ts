import {
  PBKDF2_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  deriveKeyFromPassword,
  isKdfParams,
  isSealedBox,
  newKdfParams,
  type PasswordKdfParams,
} from '@memes/shared';

/**
 * Password-encrypted backup files (SECURITY.md R-04).
 *
 *   { "format": "meme-pals-backup-encrypted", "v": 1, "kdf": PasswordKdfParams, "box": SealedBox }
 *
 * - The plaintext is the exact UTF-8 bytes of the plain backup JSON (`meme-pals-backup`, see backup.ts).
 * - Key: PBKDF2-SHA256 (fresh 16-byte salt per export, PBKDF2_ITERATIONS) → AES-GCM-256, via
 *   `deriveKeyFromPassword` from @memes/shared. Cipher: AES-GCM with a fresh random 12-byte IV and
 *   AAD "meme-pals-backup-v1".
 * - `box` is a `SealedBox` (base64url iv + ciphertext-with-tag) and is byte-compatible with
 *   `seal`/`unseal` from @memes/shared (tested both ways). We call AES-GCM here instead of `seal`
 *   only because `seal`'s base64 encoder builds one string byte by byte: fine for small secrets, but
 *   it takes seconds and ~50× the file size in memory for a big meme library. Here the ciphertext is
 *   base64url-encoded in chunks straight into Blob parts, and decoded in chunks straight from the
 *   file, so no single string ever holds the whole ciphertext.
 *
 * Limits (see SECURITY.md):
 * - MAX_BACKUP_FILE_BYTES (1 GiB): larger files are rejected as 'invalid-backup' before reading.
 * - The plain JSON must fit in one JS string (Chromium: ~512 MiB), since it is built with
 *   JSON.stringify and parsed with JSON.parse; bigger exports fail with 'backup-too-large'.
 * - WebCrypto AES-GCM is one-shot, so encrypting/decrypting holds plaintext + ciphertext in memory at
 *   once: budget roughly 3× the plain backup size in free memory.
 */

export const ENCRYPTED_BACKUP_FORMAT = 'meme-pals-backup-encrypted';
export const ENCRYPTED_BACKUP_VERSION = 1;
export const BACKUP_AAD = 'meme-pals-backup-v1';
/** Refuse backup files larger than this (checked before reading the file). */
export const MAX_BACKUP_FILE_BYTES = 1024 * 1024 * 1024;

export interface EncryptedBackupHeader {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  v: typeof ENCRYPTED_BACKUP_VERSION;
  kdf: PasswordKdfParams;
  box: { iv: string; ct: string };
}

// ─── tuning (tests) ─────────────────────────────────────────────────────────

export interface BackupKdfTuning {
  /** PBKDF2 iterations for new exports. Default PBKDF2_ITERATIONS. */
  iterations: number;
  /** Lowest iteration count accepted on import. Default PBKDF2_MIN_ITERATIONS. */
  minIterations: number;
}

const DEFAULT_TUNING: BackupKdfTuning = { iterations: PBKDF2_ITERATIONS, minIterations: PBKDF2_MIN_ITERATIONS };
let tuning: BackupKdfTuning = { ...DEFAULT_TUNING };

/**
 * Tests only: use cheap PBKDF2 parameters for every backup export/import in this JS realm
 * (engine and mock). Returns a function that restores the previous values.
 */
export function setBackupKdfTuning(t: Partial<BackupKdfTuning>): () => void {
  const prev = tuning;
  tuning = { ...tuning, ...t };
  return () => {
    tuning = prev;
  };
}

// ─── chunked base64url ──────────────────────────────────────────────────────

/** Bytes per base64 chunk; a multiple of 3 so chunks concatenate without padding. */
const ENC_CHUNK = 3 * 256 * 1024;
/** Characters per decode chunk; a multiple of 4. */
const DEC_CHUNK = 4 * 1024 * 1024;
const B64URL = /^[A-Za-z0-9_-]*$/;

function chunkToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (no padding) as a list of string parts, ~1 MiB each. Join or pass to `new Blob(parts)`. */
export function base64UrlParts(bytes: Uint8Array): string[] {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += ENC_CHUNK) parts.push(chunkToBase64Url(bytes.subarray(i, i + ENC_CHUNK)));
  return parts;
}

/** Fast base64url encoding (same output as `toBase64Url` from @memes/shared). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return base64UrlParts(bytes).join('');
}

/** Reads characters [start, end) of a base64url text. */
type CharSource = (start: number, end: number) => Promise<string> | string;

/** Decode `length` base64url characters from `read` in chunks. Throws Error('invalid-backup') on bad input. */
async function decodeBase64Url(read: CharSource, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const rem = length % 4;
  if (rem === 1) throw new Error('invalid-backup');
  const out = new Uint8Array(new ArrayBuffer(Math.floor(length / 4) * 3 + (rem ? rem - 1 : 0)));
  let o = 0;
  for (let i = 0; i < length; i += DEC_CHUNK) {
    const s = await read(i, Math.min(length, i + DEC_CHUNK));
    if (!B64URL.test(s)) throw new Error('invalid-backup');
    let bin: string;
    try {
      bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    } catch {
      throw new Error('invalid-backup');
    }
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
  }
  if (o !== out.length) throw new Error('invalid-backup');
  return out;
}

// ─── encrypt ────────────────────────────────────────────────────────────────

const subtle = () => globalThis.crypto.subtle;
const aadBytes = () => new TextEncoder().encode(BACKUP_AAD);

export interface EncryptBackupOptions {
  /** PBKDF2 iterations; defaults to the current tuning (PBKDF2_ITERATIONS). */
  iterations?: number;
}

/** Throws Error('weak-password') for an empty password. The UI enforces the real policy (≥ 8 chars). */
export function assertBackupPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) throw new Error('weak-password');
}

/** Encrypt the plain backup JSON into an encrypted backup file. */
export async function encryptBackup(plainJson: string, password: string, opts: EncryptBackupOptions = {}): Promise<Blob> {
  assertBackupPassword(password);
  const kdf = newKdfParams(opts.iterations ?? tuning.iterations);
  const key = await deriveKeyFromPassword(password, kdf);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  let ct: Uint8Array | null = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aadBytes() }, key, new TextEncoder().encode(plainJson)),
  );
  const head = JSON.stringify({ format: ENCRYPTED_BACKUP_FORMAT, v: ENCRYPTED_BACKUP_VERSION, kdf, box: { iv: bytesToBase64Url(iv), ct: '' } });
  // head ends with `""}}`: splice the ciphertext parts in between the quotes.
  const parts = base64UrlParts(ct);
  ct = null;
  return new Blob([head.slice(0, -3), ...parts, head.slice(-3)], { type: 'application/json' });
}

// ─── decrypt / open ─────────────────────────────────────────────────────────

export interface OpenBackupOptions {
  /** Lowest PBKDF2 iteration count accepted; defaults to the current tuning (PBKDF2_MIN_ITERATIONS). */
  minIterations?: number;
}

/**
 * Header of a file in the exact layout `encryptBackup` writes, up to the opening quote of `ct`.
 * Matching it lets us decode the ciphertext straight from the file without reading it into one string.
 */
const CANONICAL_HEAD =
  /^\{"format":"meme-pals-backup-encrypted","v":1,"kdf":(\{[^{}]{0,512}\}),"box":\{"iv":"([A-Za-z0-9_-]{0,64})","ct":"/;
const CANONICAL_TAIL = /"\}\}[ \t\r\n]*$/;
/** Quick check, from the first bytes only, that a file is an encrypted backup. */
const ENCRYPTED_SNIFF = /^\s*\{\s*"format"\s*:\s*"meme-pals-backup-encrypted"/;

/** Is this (first part of a) file an encrypted backup? Cheap: reads at most 256 bytes. */
export async function isEncryptedBackupFile(file: Blob): Promise<boolean> {
  return ENCRYPTED_SNIFF.test(await file.slice(0, 256).text());
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function checkHeader(kdf: unknown, iv: unknown, minIterations: number): PasswordKdfParams {
  if (!isKdfParams(kdf, minIterations)) throw new Error('invalid-backup');
  if (!isSealedBox({ iv, ct: '' })) throw new Error('invalid-backup');
  return { name: kdf.name, hash: kdf.hash, iterations: kdf.iterations, salt: kdf.salt };
}

async function decrypt(
  password: string | undefined,
  kdf: PasswordKdfParams,
  iv: string,
  ctLength: number,
  readCt: CharSource,
): Promise<string> {
  if (password === undefined || password === '') throw new Error('password-required');
  const ct = await decodeBase64Url(readCt, ctLength);
  const ivBytes = await decodeBase64Url((a, b) => iv.slice(a, b), iv.length);
  const key = await deriveKeyFromPassword(password, kdf);
  let pt: ArrayBuffer;
  try {
    pt = await subtle().decrypt({ name: 'AES-GCM', iv: ivBytes, additionalData: aadBytes() }, key, ct);
  } catch {
    throw new Error('wrong-password');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(pt);
  } catch {
    throw new Error('invalid-backup');
  }
}

/**
 * Read a backup file of either kind and return the parsed plain backup JSON (not yet validated).
 *
 * - encrypted, no password → Error('password-required')
 * - encrypted, doesn't decrypt (wrong password, tampered ciphertext/iv/salt) → Error('wrong-password')
 * - not JSON, bad header, KDF params outside the accepted range, or a file > MAX_BACKUP_FILE_BYTES
 *   → Error('invalid-backup')
 * - a legacy plain file is returned as-is (the password is ignored).
 */
export async function openBackupFile(file: Blob, password?: string, opts: OpenBackupOptions = {}): Promise<unknown> {
  const minIterations = opts.minIterations ?? tuning.minIterations;
  if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error('invalid-backup');

  // Fast path: our own layout. The ciphertext is decoded from the file in chunks.
  const head = await file.slice(0, 1024).text();
  const m = CANONICAL_HEAD.exec(head);
  const start = m ? m[0].length : 0; // the header is ASCII, so characters = bytes
  const tail = m ? await file.slice(Math.max(start, file.size - 64)).text() : '';
  if (m && CANONICAL_TAIL.test(tail)) {
    let kdfRaw: unknown;
    try {
      kdfRaw = JSON.parse(m[1]!);
    } catch {
      throw new Error('invalid-backup');
    }
    const kdf = checkHeader(kdfRaw, m[2], minIterations);
    // The file ends with `"}}` plus optional ASCII whitespace; the ciphertext is everything in between.
    const end = file.size - (tail.length - tail.replace(/[ \t\r\n]+$/, '').length) - 3;
    if (end < start) throw new Error('invalid-backup');
    const plain = await decrypt(password, kdf, m[2]!, end - start, (a, b) => file.slice(start + a, start + b).text());
    return parseJson(plain);
  }
  if (ENCRYPTED_SNIFF.test(head) && (password === undefined || password === '')) throw new Error('password-required');

  // General path: any JSON layout (e.g. a pretty-printed encrypted file, or a legacy plain backup).
  const raw = parseJson(await file.text());
  if (!isObj(raw) || raw.format !== ENCRYPTED_BACKUP_FORMAT) return raw;
  if (raw.v !== ENCRYPTED_BACKUP_VERSION || !isObj(raw.box) || !isSealedBox(raw.box)) throw new Error('invalid-backup');
  const box = raw.box;
  const kdf = checkHeader(raw.kdf, box.iv, minIterations);
  const plain = await decrypt(password, kdf, box.iv, box.ct.length, (a, b) => box.ct.slice(a, b));
  return parseJson(plain);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid-backup');
  }
}
