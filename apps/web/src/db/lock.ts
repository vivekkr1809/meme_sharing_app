import {
  PBKDF2_MIN_ITERATIONS,
  deriveKeyFromPassword,
  isKdfParams,
  isSealedBox,
  normalizePassword,
  seal,
  unseal,
  type PasswordKdfParams,
  type SealedBox,
} from '@memes/shared';

/**
 * The passcode lock record (table `lock`, key 'lock'). Stored in plaintext: it holds only the
 * KDF parameters, the data key wrapped by the passcode-derived key, and attempt bookkeeping.
 *
 *   DEK (random AES-GCM-256) ── wrapped by ── KEK = PBKDF2-SHA256(passcode, salt, iterations)
 *
 * The wrapped DEK doubles as the passcode check (AES-GCM authenticates it). change() re-wraps
 * the same DEK, so no data is re-encrypted.
 */
export interface LockRow {
  key: 'lock';
  autoLockMinutes: number;
  /** Failed unlock attempts since the last success (counted before verifying; see Engine). */
  failures: number;
  /** ms epoch before which no attempt is allowed. */
  lockedUntil: number;
  /** Present (together with wrappedKey) iff a passcode is set. */
  kdf?: PasswordKdfParams;
  wrappedKey?: SealedBox;
  /** Rows are being re-written (enable → 'encrypt', disable → 'decrypt'); resumed after unlock. */
  migrating?: 'encrypt' | 'decrypt';
}

/** A lock record read back from the DB, after validation. */
export interface LoadedLock {
  row: LockRow;
  /** A passcode is set (the record claims one, even if it is damaged). */
  enabled: boolean;
  /** kdf / wrappedKey failed validation: no passcode can open it (wipe is the way out). */
  damaged: boolean;
}

export const DEFAULT_AUTO_LOCK_MINUTES = 5;
export const MAX_AUTO_LOCK_MINUTES = 24 * 60;
export const MIN_PASSCODE_LENGTH = 4;
/** Attempts allowed before waits kick in. */
export const FREE_ATTEMPTS = 5;
/** Waits after the 5th, 6th, 7th, 8th and later failures. Never auto-wipes. */
export const BACKOFF_STEPS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const MAX_BACKOFF_MS = BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1];

const DEK_AAD = new TextEncoder().encode('memes-lock-dek-v1');

/** How long to wait after `failures` consecutive failed attempts. */
export function backoffMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return BACKOFF_STEPS_MS[Math.min(failures - FREE_ATTEMPTS, BACKOFF_STEPS_MS.length - 1)]!;
}

export function isWeakPasscode(passcode: unknown): boolean {
  return typeof passcode !== 'string' || [...normalizePassword(passcode)].length < MIN_PASSCODE_LENGTH;
}

export function isValidAutoLockMinutes(m: unknown): m is number {
  return typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= MAX_AUTO_LOCK_MINUTES;
}

export function defaultLockRow(): LockRow {
  return { key: 'lock', autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES, failures: 0, lockedUntil: 0 };
}

/**
 * Validate a stored record (it is untrusted: anyone with access to the DB could edit it).
 * `minIterations` is lowered only by tests. A wait longer than the cap (clock moved back) is clamped.
 */
export function parseLockRow(x: unknown, now: number, minIterations = PBKDF2_MIN_ITERATIONS): LoadedLock {
  const r = (x && typeof x === 'object' ? x : {}) as Partial<LockRow>;
  const row = defaultLockRow();
  if (isValidAutoLockMinutes(r.autoLockMinutes)) row.autoLockMinutes = r.autoLockMinutes;
  if (typeof r.failures === 'number' && Number.isInteger(r.failures) && r.failures > 0) row.failures = Math.min(r.failures, 1e6);
  if (typeof r.lockedUntil === 'number' && Number.isFinite(r.lockedUntil) && r.lockedUntil > now) {
    row.lockedUntil = Math.min(r.lockedUntil, now + MAX_BACKOFF_MS);
  }
  const claims = r.kdf !== undefined || r.wrappedKey !== undefined;
  if (!claims) return { row, enabled: false, damaged: false };
  const ok = isKdfParams(r.kdf, minIterations) && isSealedBox(r.wrappedKey);
  if (ok) {
    row.kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: r.kdf!.iterations, salt: r.kdf!.salt };
    row.wrappedKey = { iv: r.wrappedKey!.iv, ct: r.wrappedKey!.ct };
  }
  if (r.migrating === 'encrypt' || r.migrating === 'decrypt') row.migrating = r.migrating;
  return { row, enabled: true, damaged: !ok };
}

/** Copy without undefined keys (IndexedDB stores them as present-but-undefined). */
export function cleanLockRow(row: LockRow): LockRow {
  const out: LockRow = { key: 'lock', autoLockMinutes: row.autoLockMinutes, failures: row.failures, lockedUntil: row.lockedUntil };
  if (row.kdf) out.kdf = row.kdf;
  if (row.wrappedKey) out.wrappedKey = row.wrappedKey;
  if (row.migrating) out.migrating = row.migrating;
  return out;
}

export async function wrapDataKey(rawKey: Uint8Array, passcode: string, kdf: PasswordKdfParams): Promise<SealedBox> {
  const kek = await deriveKeyFromPassword(passcode, kdf);
  return seal(kek, rawKey, DEK_AAD);
}

/** The raw DEK, or Error('decrypt-failed') for a wrong passcode. */
export async function unwrapDataKey(box: SealedBox, passcode: string, kdf: PasswordKdfParams): Promise<Uint8Array> {
  const kek = await deriveKeyFromPassword(passcode, kdf);
  const raw = await unseal(kek, box, DEK_AAD);
  if (raw.byteLength !== 32) throw new Error('decrypt-failed');
  return raw;
}
