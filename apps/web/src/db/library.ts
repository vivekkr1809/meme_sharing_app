import { MAX_MEME_BYTES, isMemeMime, sha256Hex, toBase64Url, type MemeMeta } from '@memes/shared';
import { writable } from '../lib/store';
import type { ImportImageInput, LibraryMeme, MemeLibrary } from '../contracts';
import { toArrayBuffer, toLibraryMeme, toMemeMeta, type MemeRow, type MemesDB } from './schema';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Content-addressed meme store (MemeLibrary) plus the internal hooks the sync engine needs.
 * Metadata can exist without bytes (`has: 0`) when a partner message references a meme
 * that hasn't arrived yet; such memes are hidden from `list()` and `getUrl()` returns null.
 */
export class MemeStore implements MemeLibrary {
  readonly version = writable(0);
  private urls = new Map<string, string>();
  private pendingUrls = new Map<string, Promise<string | null>>();
  /** Bumped by revokeAll(): a getUrl() that started before it must not cache its URL. */
  private generation = 0;

  /** `guard` throws (e.g. Error('locked')) when the public API must not be used. */
  constructor(
    private readonly db: () => MemesDB,
    private readonly guard: () => void = () => {},
  ) {}

  bump(): void {
    this.version.update((v) => v + 1);
  }

  async importImage(input: ImportImageInput): Promise<LibraryMeme> {
    this.guard();
    if (!isMemeMime(input.mime)) throw new Error('invalid-mime');
    const data = toArrayBuffer(await input.blob.arrayBuffer());
    if (data.byteLength === 0) throw new Error('empty-image');
    if (data.byteLength > MAX_MEME_BYTES) throw new Error('too-large');
    const id = await sha256Hex(data);
    const db = this.db();
    const result = await db.transaction('rw', db.memes, db.memeData, async () => {
      const existing = await db.memes.get(id);
      if (existing?.has) return existing;
      const row: MemeRow = {
        id,
        mime: input.mime,
        width: input.width || existing?.width || 0,
        height: input.height || existing?.height || 0,
        size: data.byteLength,
        source: input.source,
        savedAt: existing?.savedAt ?? Date.now(),
        fav: existing?.fav ?? 0,
        has: 1,
      };
      const sourceUrl = input.sourceUrl ?? existing?.sourceUrl;
      const title = input.title ?? existing?.title;
      if (sourceUrl !== undefined) row.sourceUrl = sourceUrl;
      if (title !== undefined) row.title = title;
      await db.memes.put(row);
      await db.memeData.put({ id, mime: input.mime, data });
      return row;
    });
    this.bump();
    return toLibraryMeme(result);
  }

  async get(memeId: string): Promise<LibraryMeme | undefined> {
    this.guard();
    const row = await this.db().memes.get(memeId);
    return row ? toLibraryMeme(row) : undefined;
  }

  getUrl(memeId: string): Promise<string | null> {
    try {
      this.guard();
    } catch (e) {
      return Promise.reject(e);
    }
    const cached = this.urls.get(memeId);
    if (cached) return Promise.resolve(cached);
    const pending = this.pendingUrls.get(memeId);
    if (pending) return pending;
    const gen = this.generation;
    const p = (async () => {
      const row = await this.db().memeData.get(memeId);
      if (!row || gen !== this.generation) return null;
      const url = makeUrl(row.data, row.mime);
      this.urls.set(memeId, url);
      return url;
    })().finally(() => {
      if (this.pendingUrls.get(memeId) === p) this.pendingUrls.delete(memeId);
    });
    this.pendingUrls.set(memeId, p);
    return p;
  }

  async list(opts: { favoritesOnly?: boolean; query?: string; limit?: number } = {}): Promise<LibraryMeme[]> {
    this.guard();
    const q = opts.query?.trim().toLowerCase() ?? '';
    const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
    const out: LibraryMeme[] = [];
    await this.db()
      .memes.orderBy('savedAt')
      .reverse()
      .until(() => out.length >= limit)
      .each((r) => {
        if (!r.has) return;
        if (opts.favoritesOnly && !r.fav) return;
        if (q && !`${r.title ?? ''}\n${r.source}`.toLowerCase().includes(q)) return;
        if (out.length < limit) out.push(toLibraryMeme(r));
      });
    return out;
  }

  async toggleFavorite(memeId: string): Promise<boolean> {
    this.guard();
    const db = this.db();
    const fav = await db.transaction('rw', db.memes, async () => {
      const row = await db.memes.get(memeId);
      if (!row) return null;
      const next: 0 | 1 = row.fav ? 0 : 1;
      await db.memes.update(memeId, { fav: next });
      return next === 1;
    });
    if (fav === null) return false;
    this.bump();
    return fav;
  }

  async remove(memeId: string): Promise<void> {
    this.guard();
    const db = this.db();
    await db.transaction('rw', db.memes, db.memeData, async () => {
      await db.memes.delete(memeId);
      await db.memeData.delete(memeId);
    });
    this.revoke(memeId);
    this.bump();
  }

  // ─── internal (sync engine / backup) ─────────────────────────────────────

  async getMetas(ids: string[]): Promise<Map<string, MemeMeta>> {
    const rows = await this.db().memes.bulkGet(ids);
    const out = new Map<string, MemeMeta>();
    for (const r of rows) if (r?.has) out.set(r.id, toMemeMeta(r));
    return out;
  }

  async getData(memeId: string): Promise<{ mime: string; data: Uint8Array } | undefined> {
    const row = await this.db().memeData.get(memeId);
    return row ? { mime: row.mime, data: new Uint8Array(row.data) } : undefined;
  }

  /**
   * A message referenced this meme. Records (or upgrades) its metadata so the bytes can be
   * requested now and after reconnects/reloads. Returns true if the bytes are missing.
   */
  async noteReferenced(memeId: string, meta?: MemeMeta): Promise<boolean> {
    if (!HEX64.test(memeId)) return false;
    const db = this.db();
    const missing = await db.transaction('rw', db.memes, async () => {
      const existing = await db.memes.get(memeId);
      if (existing?.has) return false;
      const good = meta && meta.id === memeId && meta.size > 0 && meta.size <= MAX_MEME_BYTES ? toMemeMeta(meta) : undefined;
      if (existing && (!good || existing.size >= 0)) return true;
      const row: MemeRow = {
        ...(good ?? { id: memeId, mime: '', width: 0, height: 0, size: -1, source: 'upload' as const }),
        savedAt: existing?.savedAt ?? Date.now(),
        fav: existing?.fav ?? 0,
        has: 0,
      };
      await db.memes.put(row);
      return true;
    });
    return missing;
  }

  /** Ids of memes we know about but whose bytes are missing. */
  async missingIds(): Promise<string[]> {
    return (await this.db().memes.where('has').equals(0).primaryKeys()) as string[];
  }

  /**
   * Store bytes received from the partner after verifying them against what we expect:
   * the meme must be known-but-missing, sha256(data) must equal its id, and size + mime must
   * match the metadata from the `msg` frame (when known). Returns false (and logs) on rejection.
   */
  async acceptBlob(memeId: string, mime: string, data: Uint8Array): Promise<boolean> {
    const db = this.db();
    const row = await db.memes.get(memeId);
    const reject = (why: string) => {
      console.warn(`[sync] dropped meme blob ${memeId.slice(0, 12)}…: ${why}`);
      return false;
    };
    if (!row) return reject('not requested');
    if (row.has) return false; // duplicate delivery; already stored
    if (!isMemeMime(mime)) return reject(`bad mime ${String(mime).slice(0, 64)}`);
    if (data.byteLength === 0 || data.byteLength > MAX_MEME_BYTES) return reject(`bad size ${data.byteLength}`);
    if (row.size >= 0 && row.size !== data.byteLength) return reject(`size ${data.byteLength} != ${row.size}`);
    if (row.mime && row.mime !== mime) return reject(`mime ${mime} != ${row.mime}`);
    const hash = await sha256Hex(data);
    if (hash !== memeId) return reject('hash mismatch');
    const buf = toArrayBuffer(data);
    await db.transaction('rw', db.memes, db.memeData, async () => {
      const cur = await db.memes.get(memeId);
      if (!cur || cur.has) return;
      await db.memes.put({ ...cur, mime, size: buf.byteLength, has: 1 });
      await db.memeData.put({ id: memeId, mime, data: buf });
    });
    this.bump();
    return true;
  }

  revoke(memeId: string): void {
    const url = this.urls.get(memeId);
    if (!url) return;
    this.urls.delete(memeId);
    if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  }

  revokeAll(): void {
    this.generation++;
    for (const id of [...this.urls.keys()]) this.revoke(id);
    this.pendingUrls.clear();
  }
}

function makeUrl(data: ArrayBuffer, storedMime: string): string {
  // Last line of defence: a blob: URL lives on our origin, so never give one a type the
  // browser would render as a document (SVG, HTML). Rows written before the allow-list
  // existed fall back to an inert type; raster images still render in <img>.
  const mime = isMemeMime(storedMime) ? storedMime : 'application/octet-stream';
  if (typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
    return URL.createObjectURL(new Blob([data], { type: mime }));
  }
  // Environments without object URLs (some test DOMs): fall back to a data URL.
  const b64 = toBase64Url(data).replace(/-/g, '+').replace(/_/g, '/');
  return `data:${mime};base64,${b64}${'==='.slice((b64.length + 3) % 4)}`;
}
