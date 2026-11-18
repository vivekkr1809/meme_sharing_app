import Dexie from 'dexie';
import {
  DEVICE_ID_PATTERN,
  MAX_MEME_BYTES,
  ULID_PATTERN,
  fromBase64Url,
  isMemeMeta,
  isMessage,
  sha256Hex,
  type MemeMeta,
  type Message,
} from '@memes/shared';
import type { Settings } from '../contracts';
import { bytesToBase64Url, openBackupFile } from './backupCrypto';
import { mergeSettings, sanitizeSettings } from './settings';
import {
  toArrayBuffer,
  toMemeMeta,
  toMessage,
  toMessageRow,
  type MemeRow,
  type MemesDB,
  type MessageRow,
  type ProfileRow,
} from './schema';

/**
 * Backup file format (a single JSON document):
 *
 *   { format: 'meme-pals-backup', v: 1, exportedAt, profile, settings, messages, memes }
 *
 * - `profile` never contains the pairing secret: after restoring, the devices must be
 *   paired again (create/accept a new code). History is kept and re-syncs on connect.
 * - `memes[].data` is the image bytes, base64url. Bytes are verified against the
 *   content id (sha256) on import; memes without valid bytes are imported as "missing"
 *   and requested from the partner on the next connection.
 * - Import is a merge: existing messages/memes are kept, so importing twice is a no-op.
 *
 * With a password, this JSON is the plaintext of an encrypted file (see backupCrypto.ts).
 * Legacy plain files keep importing without a password.
 */

export const BACKUP_FORMAT = 'meme-pals-backup';
export const BACKUP_VERSION = 1;

export interface BackupProfile {
  deviceId: string;
  displayName: string;
  createdAt: number;
  partnerName?: string;
  partnerDeviceId?: string;
  lastReadId?: string;
  peerReadId?: string;
}

export interface BackupMessage extends Message {
  deliveredAt?: number;
}

export interface BackupMeme extends MemeMeta {
  savedAt: number;
  favorite: boolean;
  /** base64url bytes; absent if this device never received them. */
  data?: string;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  v: typeof BACKUP_VERSION;
  exportedAt: number;
  profile: BackupProfile | null;
  settings: Settings;
  messages: BackupMessage[];
  memes: BackupMeme[];
}

export async function buildBackup(db: MemesDB): Promise<BackupFile> {
  const { profile, settings, messages, memes, data } = await db.transaction(
    'r',
    [db.profile, db.settings, db.messages, db.memes, db.memeData],
    async () => ({
      profile: await db.profile.get('me'),
      settings: await db.settings.get('settings'),
      messages: await db.messages.toArray(),
      memes: await db.memes.toArray(),
      data: await db.memeData.toArray(),
    }),
  );
  const bytes = new Map(data.map((d) => [d.id, d.data]));
  return {
    format: BACKUP_FORMAT,
    v: BACKUP_VERSION,
    exportedAt: Date.now(),
    profile: profile ? stripProfile(profile) : null,
    settings: mergeSettings(settings?.value),
    messages: messages.map((m) => {
      const out: BackupMessage = toMessage(m);
      if (m.deliveredAt !== undefined) out.deliveredAt = m.deliveredAt;
      return out;
    }),
    memes: memes.map((m) => {
      const out: BackupMeme = { ...toMemeMeta(m), savedAt: m.savedAt, favorite: m.fav === 1 };
      const b = m.has ? bytes.get(m.id) : undefined;
      if (b) out.data = bytesToBase64Url(new Uint8Array(b));
      return out;
    }),
  };
}

/** The plain backup JSON. Throws Error('backup-too-large') if it doesn't fit in one string. */
export function serializeBackup(file: BackupFile): string {
  try {
    return JSON.stringify(file);
  } catch (e) {
    if (e instanceof RangeError) throw new Error('backup-too-large');
    throw e;
  }
}

/**
 * Open a backup file (encrypted or legacy plain) and validate it.
 * Throws Error('password-required' | 'wrong-password' | 'invalid-backup').
 */
export async function readBackup(file: Blob, password?: string): Promise<PreparedBackup> {
  return prepareBackupValue(await openBackupFile(file, password));
}

function stripProfile(p: ProfileRow): BackupProfile {
  // Deliberately NOT copying p.secret.
  const out: BackupProfile = { deviceId: p.deviceId, displayName: p.displayName, createdAt: p.createdAt };
  if (p.partnerName !== undefined) out.partnerName = p.partnerName;
  if (p.partnerDeviceId !== undefined) out.partnerDeviceId = p.partnerDeviceId;
  if (p.lastReadId !== undefined) out.lastReadId = p.lastReadId;
  if (p.peerReadId !== undefined) out.peerReadId = p.peerReadId;
  return out;
}

export interface PreparedBackup {
  profile: BackupProfile | null;
  settings: Partial<Settings>;
  messages: BackupMessage[];
  memes: { row: MemeRow; data?: ArrayBuffer }[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const optStr = (x: unknown) => (typeof x === 'string' ? x : undefined);
const optUlid = (x: unknown) => (typeof x === 'string' && ULID_PATTERN.test(x) ? x : undefined);

/** Parse + validate untrusted backup JSON. Invalid entries are skipped; a wrong format throws 'invalid-backup'. */
export async function prepareBackup(text: string): Promise<PreparedBackup> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('invalid-backup');
  }
  return prepareBackupValue(raw);
}

/** Validate already-parsed backup JSON. */
export async function prepareBackupValue(raw: unknown): Promise<PreparedBackup> {
  if (!isObj(raw) || raw.format !== BACKUP_FORMAT || raw.v !== BACKUP_VERSION) throw new Error('invalid-backup');
  if (!Array.isArray(raw.messages) || !Array.isArray(raw.memes)) throw new Error('invalid-backup');

  let profile: BackupProfile | null = null;
  const p = raw.profile;
  if (isObj(p) && typeof p.deviceId === 'string' && DEVICE_ID_PATTERN.test(p.deviceId)) {
    profile = {
      deviceId: p.deviceId,
      displayName: typeof p.displayName === 'string' ? p.displayName.slice(0, 64) : '',
      createdAt: typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : Date.now(),
    };
    const partnerName = optStr(p.partnerName);
    const partnerDeviceId = optStr(p.partnerDeviceId);
    const lastReadId = optUlid(p.lastReadId);
    const peerReadId = optUlid(p.peerReadId);
    if (partnerName !== undefined) profile.partnerName = partnerName;
    if (partnerDeviceId !== undefined) profile.partnerDeviceId = partnerDeviceId;
    if (lastReadId !== undefined) profile.lastReadId = lastReadId;
    if (peerReadId !== undefined) profile.peerReadId = peerReadId;
  }

  const messages: BackupMessage[] = [];
  for (const m of raw.messages) {
    if (!isMessage(m)) continue;
    const out: BackupMessage = toMessage(m);
    const d = (m as unknown as Record<string, unknown>).deliveredAt;
    if (typeof d === 'number' && Number.isFinite(d)) out.deliveredAt = d;
    messages.push(out);
  }

  const memes: PreparedBackup['memes'] = [];
  for (const m of raw.memes) {
    if (!isMemeMeta(m) || m.size > MAX_MEME_BYTES) continue;
    const x = m as unknown as Record<string, unknown>;
    const row: MemeRow = {
      ...toMemeMeta(m),
      savedAt: typeof x.savedAt === 'number' && Number.isFinite(x.savedAt) ? x.savedAt : Date.now(),
      fav: x.favorite === true ? 1 : 0,
      has: 0,
    };
    let data: ArrayBuffer | undefined;
    if (typeof x.data === 'string') {
      try {
        const bytes = fromBase64Url(x.data);
        if (bytes.byteLength === m.size && (await sha256Hex(bytes)) === m.id) data = toArrayBuffer(bytes);
      } catch {
        // bad base64: import as missing
      }
      if (!data) console.warn(`[backup] meme ${m.id.slice(0, 12)}… has invalid bytes; importing as missing`);
    }
    if (data) row.has = 1;
    memes.push(data ? { row, data } : { row });
  }

  // R-03: never take the relay URL from a backup file; a crafted backup could otherwise
  // silently move signaling to someone else's relay.
  const { relayUrl: _ignoredRelay, ...settings } = sanitizeSettings(raw.settings);
  return { profile, settings, messages, memes };
}

/** Merge a prepared backup into the DB in one transaction. Returns how many messages/memes were added. */
export async function applyBackup(db: MemesDB, b: PreparedBackup): Promise<{ messages: number; memes: number }> {
  return db.transaction('rw', [db.profile, db.settings, db.messages, db.memes, db.memeData, db.outbox], async () => {
    // ── identity ──
    let local = await db.profile.get('me');
    const bp = b.profile;
    if (bp) {
      const ownCount = local
        ? await db.messages
            .where('[authorId+id]')
            .between([local.deviceId, Dexie.minKey], [local.deviceId, Dexie.maxKey], true, true)
            .count()
        : 0;
      if (!local) {
        local = { key: 'me', ...bp };
      } else if (local.deviceId !== bp.deviceId && ownCount === 0) {
        // Fresh install (no own messages yet) restoring a backup: adopt the backed-up identity
        // so the restored history keeps its "mine" attribution. A pairing secret created on
        // this device before importing is kept (backups never contain one).
        const secret = local.secret;
        local = { ...local, ...bp, key: 'me', displayName: local.displayName || bp.displayName };
        if (secret) local.secret = secret;
        else delete local.secret;
      } else if (local.deviceId === bp.deviceId) {
        local = {
          ...local,
          partnerName: local.partnerName ?? bp.partnerName,
          partnerDeviceId: local.partnerDeviceId ?? bp.partnerDeviceId,
          lastReadId: maxId(local.lastReadId, bp.lastReadId),
          peerReadId: maxId(local.peerReadId, bp.peerReadId),
        };
        for (const k of ['partnerName', 'partnerDeviceId', 'lastReadId', 'peerReadId'] as const) {
          if (local[k] === undefined) delete local[k];
        }
      }
      await db.profile.put(local);
    }
    const me = local?.deviceId;

    // ── settings ──
    if (Object.keys(b.settings).length) {
      const cur = await db.settings.get('settings');
      await db.settings.put({ key: 'settings', value: { ...(cur?.value ?? {}), ...b.settings } });
    }

    // ── messages ──
    let addedMessages = 0;
    const existing = await db.messages.bulkGet(b.messages.map((m) => m.id));
    const puts: MessageRow[] = [];
    const outbox: string[] = [];
    b.messages.forEach((m, i) => {
      const cur = existing[i];
      if (!cur) {
        const row = toMessageRow(m, m.deliveredAt !== undefined ? { deliveredAt: m.deliveredAt } : {});
        puts.push(row);
        addedMessages++;
        if (m.authorId === me && row.deliveredAt === undefined) outbox.push(m.id);
      } else if (cur.deliveredAt === undefined && m.deliveredAt !== undefined && cur.authorId === m.authorId) {
        puts.push({ ...cur, deliveredAt: m.deliveredAt });
      }
    });
    await db.messages.bulkPut(puts);
    if (outbox.length) {
      const have = await db.outbox.bulkGet(outbox);
      await db.outbox.bulkPut(outbox.filter((_, i) => !have[i]).map((id) => ({ id, attempts: 0, lastTriedAt: 0 })));
    }

    // ── memes ──
    let addedMemes = 0;
    const curMemes = await db.memes.bulkGet(b.memes.map((m) => m.row.id));
    for (let i = 0; i < b.memes.length; i++) {
      const { row, data } = b.memes[i]!;
      const cur = curMemes[i];
      if (cur?.has) {
        if (row.fav && !cur.fav) await db.memes.update(cur.id, { fav: 1 });
        continue;
      }
      if (!cur && !data) {
        await db.memes.put(row);
        continue;
      }
      if (cur && !data) {
        if (row.fav && !cur.fav) await db.memes.update(cur.id, { fav: 1 });
        continue;
      }
      await db.memes.put({ ...row, savedAt: cur?.savedAt ?? row.savedAt, fav: cur?.fav || row.fav ? 1 : 0, has: 1 });
      await db.memeData.put({ id: row.id, mime: row.mime, data: data! });
      addedMemes++;
    }

    return { messages: addedMessages, memes: addedMemes };
  });
}

function maxId(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}
