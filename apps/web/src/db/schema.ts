import Dexie, { type Table } from 'dexie';
import type { MemeMeta, Message, MessageKind } from '@memes/shared';
import type { LibraryMeme, Settings } from '../contracts';

/**
 * Local IndexedDB schema (Dexie). This is the ONLY place user data is stored.
 *
 *   profile   key 'me'        identity, pairing secret (base64url), partner info, read markers
 *   settings  key 'settings'  user settings (merged with DEFAULT_SETTINGS on read)
 *   messages  ULID            every message (text, meme, reaction) from both authors
 *   memes     sha256 hex      meme metadata; `has` = 1 once the bytes are stored
 *   memeData  sha256 hex      meme bytes as ArrayBuffer (+ mime); kept apart so listing memes is cheap
 *   outbox    ULID            own messages not yet acked by the partner
 *
 * Versioning: bump `DB_VERSION` and add a new `this.version(n).stores(...)` call (with an
 * `.upgrade()` if rows need rewriting). Never edit an existing version's definition.
 */

/** 'c' = chat item (text/meme, displayed), 'r' = reaction (folded into its target). */
export type Lane = 'c' | 'r';

export interface ProfileRow {
  key: 'me';
  deviceId: string;
  displayName: string;
  createdAt: number;
  /** Pairing secret, base64url. Absent when unpaired. Never leaves the device (not in backups). */
  secret?: string;
  partnerName?: string;
  partnerDeviceId?: string;
  /** Our read marker: newest partner message we have read. */
  lastReadId?: string;
  /** Partner's read marker: own messages with id <= this are 'read'. */
  peerReadId?: string;
}

export interface SettingsRow {
  key: 'settings';
  value: Partial<Settings>;
}

export interface MessageRow extends Message {
  lane: Lane;
  /** Own messages: when the partner acked it. */
  deliveredAt?: number;
  /** Partner messages: when we stored it. */
  receivedAt?: number;
}

export interface MemeRow extends MemeMeta {
  savedAt: number;
  /** 0 | 1 (booleans are not indexable). */
  fav: 0 | 1;
  /** 0 | 1: whether the bytes are in memeData. */
  has: 0 | 1;
}

export interface MemeDataRow {
  id: string;
  mime: string;
  data: ArrayBuffer;
}

export interface OutboxRow {
  id: string;
  attempts: number;
  lastTriedAt: number;
}

export const DB_VERSION = 1;

export class MemesDB extends Dexie {
  profile!: Table<ProfileRow, string>;
  settings!: Table<SettingsRow, string>;
  messages!: Table<MessageRow, string>;
  memes!: Table<MemeRow, string>;
  memeData!: Table<MemeDataRow, string>;
  outbox!: Table<OutboxRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      profile: '&key',
      settings: '&key',
      // [lane+id]: chat window paging + unread count; [lane+replyTo]: reactions per target;
      // [authorId+id]: "own messages newer than X" for the sync stream.
      messages: '&id, [lane+id], [lane+replyTo], [authorId+id]',
      memes: '&id, savedAt, has',
      memeData: '&id',
      outbox: '&id',
    });
  }
}

export function laneOf(kind: MessageKind): Lane {
  return kind === 'reaction' ? 'r' : 'c';
}

/** Copy only the wire fields of a Message (drops local bookkeeping and undefined keys). */
export function toMessage(m: Message): Message {
  const out: Message = { id: m.id, authorId: m.authorId, kind: m.kind, createdAt: m.createdAt };
  if (m.text !== undefined) out.text = m.text;
  if (m.memeId !== undefined) out.memeId = m.memeId;
  if (m.replyTo !== undefined) out.replyTo = m.replyTo;
  if (m.emoji !== undefined) out.emoji = m.emoji;
  return out;
}

export function toMessageRow(m: Message, extra: Partial<Pick<MessageRow, 'deliveredAt' | 'receivedAt'>> = {}): MessageRow {
  const row: MessageRow = { ...toMessage(m), lane: laneOf(m.kind) };
  if (extra.deliveredAt !== undefined) row.deliveredAt = extra.deliveredAt;
  if (extra.receivedAt !== undefined) row.receivedAt = extra.receivedAt;
  return row;
}

export function toMemeMeta(m: MemeMeta): MemeMeta {
  const out: MemeMeta = { id: m.id, mime: m.mime, width: m.width, height: m.height, size: m.size, source: m.source };
  if (m.sourceUrl !== undefined) out.sourceUrl = m.sourceUrl;
  if (m.title !== undefined) out.title = m.title;
  return out;
}

export function toLibraryMeme(r: MemeRow): LibraryMeme {
  return { ...toMemeMeta(r), savedAt: r.savedAt, favorite: r.fav === 1 };
}

/** A fresh, exactly-sized ArrayBuffer copy of the bytes (portable across Safari / fake-indexeddb). */
export function toArrayBuffer(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  const src = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new ArrayBuffer(src.byteLength);
  new Uint8Array(out).set(src);
  return out;
}
