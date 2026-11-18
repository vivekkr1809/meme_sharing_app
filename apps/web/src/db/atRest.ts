import type { DBCore, DBCoreCursor, DBCoreTable, DBCoreTransaction, Middleware } from 'dexie';
import type Dexie from 'dexie';
import { fromBase64Url, seal, toBase64Url, unseal } from '@memes/shared';

/**
 * Encryption at rest for the passcode lock: a Dexie DBCore middleware.
 *
 * Configured content fields are AES-GCM encrypted with the in-memory data key (DEK) on every
 * write and decrypted on every read (get, getMany, query, openCursor). Index and key fields
 * (ids, authorId, memeId, replyTo, timestamps, flags) stay plaintext because sync and queries
 * need them. The AAD binds table + field + primary key, so a ciphertext copied into another
 * row or field fails to decrypt.
 *
 * WebCrypto is asynchronous, and an IndexedDB transaction commits as soon as it has no pending
 * request at the end of a task. While a crypto call is in flight the middleware therefore keeps
 * the transaction alive with cheap dummy reads ("spinning", the same trick as Dexie.waitFor) and
 * resumes inside one of their success callbacks, where the transaction is active again.
 */

/** Fields encrypted per table. Everything else is stored as-is. */
export const ENCRYPTED_FIELDS: Readonly<Record<string, { readonly strings?: readonly string[]; readonly bytes?: readonly string[] }>> = {
  profile: { strings: ['secret', 'displayName', 'partnerName'] },
  messages: { strings: ['text', 'emoji'] },
  memes: { strings: ['title', 'sourceUrl'] },
  memeData: { bytes: ['data'] },
};

/** Stored in place of an encrypted field. `t: 's'` → string, `t: 'b'` → ArrayBuffer (ct kept binary). */
export interface EncryptedField {
  $enc: 1;
  t: 's' | 'b';
  iv: string;
  ct: string | ArrayBuffer;
}

export function isEncryptedField(x: unknown): x is EncryptedField {
  const e = x as EncryptedField;
  return (
    !!e &&
    typeof e === 'object' &&
    e.$enc === 1 &&
    (e.t === 's' || e.t === 'b') &&
    typeof e.iv === 'string' &&
    (typeof e.ct === 'string' || e.ct instanceof ArrayBuffer)
  );
}

/**
 * Shared, mutable crypto state read by the middleware on every call.
 *   key           - the DEK while unlocked (null when locked or disabled)
 *   encryptWrites - true while a passcode is set (writes are encrypted; without a key they are
 *                   refused with Error('locked')). False when disabled, and while disable()
 *                   decrypts the rows back.
 */
export class AtRestCrypto {
  key: CryptoKey | null = null;
  encryptWrites = false;

  reset(): void {
    this.key = null;
    this.encryptWrites = false;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD_PREFIX = 'memes-at-rest-v1';

function aad(table: string, field: string, pk: unknown): Uint8Array {
  return enc.encode(`${AAD_PREFIX}\u0000${table}\u0000${field}\u0000${JSON.stringify(pk)}`);
}

function lockedError(): Error {
  return new Error('locked');
}

type Row = Record<string, unknown>;
type FieldCfg = (typeof ENCRYPTED_FIELDS)[string];

/** The fields of `row` that hold ciphertext (to decrypt), or null if there are none. */
function sealedFields(cfg: FieldCfg, row: unknown): string[] | null {
  if (!row || typeof row !== 'object') return null;
  let out: string[] | null = null;
  for (const f of [...(cfg.strings ?? []), ...(cfg.bytes ?? [])]) {
    if (isEncryptedField((row as Row)[f])) (out ??= []).push(f);
  }
  return out;
}

/** The fields of `row` that hold plaintext to encrypt, or null if there are none. */
function plainFields(cfg: FieldCfg, row: unknown): string[] | null {
  if (!row || typeof row !== 'object') return null;
  let out: string[] | null = null;
  for (const f of cfg.strings ?? []) if (typeof (row as Row)[f] === 'string') (out ??= []).push(f);
  for (const f of cfg.bytes ?? []) {
    const v = (row as Row)[f];
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) (out ??= []).push(f);
  }
  return out;
}

async function encryptRow(state: AtRestCrypto, table: string, pk: unknown, row: Row, fields: string[]): Promise<Row> {
  const key = state.key;
  if (!key) throw lockedError();
  const out: Row = { ...row };
  await Promise.all(
    fields.map(async (f) => {
      const v = row[f];
      if (typeof v === 'string') {
        const box = await seal(key, enc.encode(v), aad(table, f, pk));
        out[f] = { $enc: 1, t: 's', iv: box.iv, ct: box.ct } satisfies EncryptedField;
      } else {
        const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
        const box = await seal(key, bytes, aad(table, f, pk));
        out[f] = { $enc: 1, t: 'b', iv: box.iv, ct: fromBase64Url(box.ct).buffer } satisfies EncryptedField;
      }
    }),
  );
  return out;
}

async function decryptRow(state: AtRestCrypto, table: string, pk: unknown, row: Row, fields: string[]): Promise<Row> {
  const key = state.key;
  if (!key) throw lockedError();
  const out: Row = { ...row };
  await Promise.all(
    fields.map(async (f) => {
      const e = row[f] as EncryptedField;
      const ct = typeof e.ct === 'string' ? e.ct : toBase64Url(e.ct);
      const pt = await unseal(key, { iv: e.iv, ct }, aad(table, f, pk));
      out[f] = e.t === 's' ? dec.decode(pt) : pt.buffer.byteLength === pt.byteLength ? pt.buffer : pt.slice().buffer;
    }),
  );
  return out;
}

/**
 * Resolve with `work`'s outcome inside an IDB success callback of `trans`, keeping the
 * transaction alive meanwhile. Falls back to plain `work` if `trans` isn't an IDBTransaction.
 */
export function inTransaction<T>(trans: DBCoreTransaction, storeName: string, work: Promise<T>): Promise<T> {
  const idb = trans as unknown as IDBTransaction;
  if (typeof (idb as { objectStore?: unknown })?.objectStore !== 'function') return work;
  return new Promise<T>((resolve, reject) => {
    let outcome: { ok: true; v: T } | { ok: false; e: unknown } | undefined;
    work.then(
      (v) => (outcome = { ok: true, v }),
      (e) => (outcome = { ok: false, e }),
    );
    let store: IDBObjectStore;
    try {
      store = idb.objectStore(storeName);
    } catch {
      work.then(resolve, reject);
      return;
    }
    const spin = () => {
      if (outcome) {
        if (outcome.ok) resolve(outcome.v);
        else reject(outcome.e);
        return;
      }
      try {
        const r = store.get(-Infinity);
        r.onsuccess = spin;
        r.onerror = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          reject(r.error ?? new Error('transaction-failed'));
        };
      } catch (e) {
        // The transaction already finished (or was aborted): nothing left to keep alive.
        work.then(resolve, () => reject(e));
      }
    };
    spin();
  });
}

function wrapTable(down: DBCoreTable, state: AtRestCrypto): DBCoreTable {
  const name = down.name;
  const cfg = ENCRYPTED_FIELDS[name];
  if (!cfg) return down;
  const pkOf = (row: unknown, fallback?: unknown) => down.schema.primaryKey.extractKey?.(row) ?? fallback;

  /** Decrypt one value; returns null when it holds no ciphertext (so no spinning is needed). */
  const decodeOne = (row: unknown): Promise<unknown> | null => {
    const fields = sealedFields(cfg, row);
    if (!fields) return null;
    return decryptRow(state, name, pkOf(row), row as Row, fields);
  };

  const decodeMany = (trans: DBCoreTransaction, rows: readonly unknown[]): Promise<unknown[]> | unknown[] => {
    let pending = false;
    const out = rows.map((r) => {
      const p = decodeOne(r);
      if (p) pending = true;
      return p ?? r;
    });
    return pending ? inTransaction(trans, name, Promise.all(out)) : out;
  };

  return {
    ...down,
    mutate(req) {
      if (req.type !== 'add' && req.type !== 'put') return down.mutate(req);
      if (!state.encryptWrites) return down.mutate(req);
      if (!state.key) return Promise.reject(lockedError());
      let pending = false;
      const values = req.values.map((v, i) => {
        const fields = plainFields(cfg, v);
        if (!fields) return v;
        pending = true;
        return encryptRow(state, name, pkOf(v, req.keys?.[i]), v as Row, fields);
      });
      if (!pending) return down.mutate(req);
      return inTransaction(req.trans, name, Promise.all(values)).then((encrypted) => down.mutate({ ...req, values: encrypted }));
    },
    get(req) {
      return down.get(req).then((v) => {
        const p = decodeOne(v);
        return p ? inTransaction(req.trans, name, p) : v;
      });
    },
    getMany(req) {
      return down.getMany(req).then((rows) => decodeMany(req.trans, rows));
    },
    query(req) {
      if (!req.values) return down.query(req);
      return down.query(req).then(async (res) => ({ ...res, result: await decodeMany(req.trans, res.result) }));
    },
    openCursor(req) {
      if (!req.values) return down.openCursor(req);
      return down.openCursor(req).then((c) => c && decryptingCursor(c, req.trans, name, decodeOne));
    },
  };
}

/** A cursor whose `value` is the decrypted row. Each step waits for decryption before onNext. */
function decryptingCursor(
  c: DBCoreCursor,
  trans: DBCoreTransaction,
  storeName: string,
  decodeOne: (row: unknown) => Promise<unknown> | null,
): DBCoreCursor {
  let value: unknown;
  const cursor: DBCoreCursor = {
    get trans() {
      return c.trans;
    },
    get key() {
      return c.key;
    },
    get primaryKey() {
      return c.primaryKey;
    },
    get value() {
      return value;
    },
    get done() {
      return c.done;
    },
    continue: (key?: unknown) => c.continue(key),
    continuePrimaryKey: (key: unknown, primaryKey: unknown) => c.continuePrimaryKey(key, primaryKey),
    advance: (n: number) => c.advance(n),
    stop: (v?: unknown) => c.stop(v),
    fail: (e: Error) => c.fail(e),
    next() {
      let gotOne = 1;
      return this.start(() => (gotOne-- ? this.continue() : this.stop())).then(() => this);
    },
    start(onNext: () => void) {
      return c.start(() => {
        const raw = c.value;
        const p = decodeOne(raw);
        if (!p) {
          value = raw;
          onNext();
          return;
        }
        inTransaction(trans, storeName, p).then(
          (v) => {
            value = v;
            try {
              onNext();
            } catch (e) {
              c.fail(e as Error);
            }
          },
          (e) => c.fail(e as Error),
        );
      });
    },
  };
  return cursor;
}

/** Lowest level: everything above (Dexie's own middlewares, hooks, the app) sees plaintext. */
export function atRestMiddleware(state: AtRestCrypto): Middleware<DBCore> {
  return {
    stack: 'dbcore',
    name: 'AtRestEncryption',
    level: -10,
    create: (down) => ({
      ...down,
      table: (tableName: string) => wrapTable(down.table(tableName), state),
    }),
  };
}

/** Batch sizes for rewriteAll(): bytes rows are large, keep their transactions small. */
const BATCH: Record<string, number> = { profile: 10, messages: 200, memes: 200, memeData: 2 };

/**
 * Re-write every row of every encrypted table through the middleware, so each row ends up in
 * the form `state` dictates (encrypted, or plaintext while disabling). Each batch is its own
 * transaction: a crash leaves a mix of both forms, which reads handle, and running this again
 * (the lock record remembers that a migration was in progress) finishes the job.
 */
export async function rewriteAll(db: Dexie): Promise<void> {
  for (const name of Object.keys(ENCRYPTED_FIELDS)) {
    const table = db.table(name);
    const keyPath = table.schema.primKey.keyPath as string;
    const size = BATCH[name] ?? 100;
    let last: unknown;
    for (;;) {
      const done = await db.transaction('rw', table, async () => {
        const coll = last === undefined ? table.orderBy(':id') : table.where(':id').above(last);
        const rows = (await coll.limit(size).toArray()) as Row[];
        if (rows.length) {
          await table.bulkPut(rows);
          last = rows[rows.length - 1]![keyPath];
        }
        return rows.length < size;
      });
      if (done) break;
    }
  }
}
