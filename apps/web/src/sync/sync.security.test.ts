import 'fake-indexeddb/auto';
import { resolveObjectURL } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, toBase64Url, ulid } from '@memes/shared';
import { BACKUP_FORMAT, BACKUP_VERSION } from '../db/backup';
import { pairedDevices, randomImage, rawDb, settle, sleep, type Device } from './testkit';

/**
 * Security review (A7): the sync engine and meme store against a malicious (or buggy)
 * partner, and against crafted backup files.
 */

const open: Device[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((d) => d.svc.dispose()));
});

async function pair() {
  const p = await pairedDevices();
  open.push(p.A, p.B);
  return p;
}

const enc = new TextEncoder();
const SVG = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
/** A ULID whose timestamp is in the year 10889 (the largest a ULID can encode). */
const FAR_FUTURE_ID = '7ZZZZZZZZZ' + 'ABCDEFGHJKMNPQRS';

describe('malicious partner', () => {
  it('never stores an SVG meme received over P2P', async () => {
    const { A, B, loop } = await pair();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const memeId = await sha256Hex(SVG);
    const authorId = A.svc.pairing.profile.get()!.deviceId;
    // 1) With SVG metadata the whole frame is invalid and dropped.
    loop.a.send({
      type: 'msg',
      message: { id: ulid(), authorId, kind: 'meme', memeId, createdAt: Date.now() },
      meme: { id: memeId, mime: 'image/svg+xml', width: 1, height: 1, size: SVG.byteLength, source: 'upload' },
    });
    await settle([A, B]);
    expect(B.svc.chat.messages.get().some((m) => m.memeId === memeId)).toBe(false);

    // 2) Without metadata the meme is requested; the SVG bytes that come back are refused
    //    even though their hash matches.
    loop.a.send({ type: 'msg', message: { id: ulid(), authorId, kind: 'meme', memeId, createdAt: Date.now() } });
    await settle([A, B]);
    await loop.a.sendBlob(memeId, 'image/svg+xml', SVG);
    await settle([A, B]);
    expect(await B.svc.library.getUrl(memeId)).toBeNull();
    expect(await rawDb(B.dbName, (db) => db.memeData.get(memeId))).toBeUndefined();
  });

  it('serves a meme once per flood of meme-want requests', async () => {
    const { A, B, loop } = await pair();
    const bytes = randomImage(4000, 11);
    const meme = await A.svc.library.importImage({
      blob: new Blob([bytes], { type: 'image/png' }),
      mime: 'image/png',
      width: 1,
      height: 1,
      source: 'upload',
    });
    const real = loop.a.sendBlob.bind(loop.a);
    let calls = 0;
    loop.a.sendBlob = async (...args) => {
      calls++;
      await sleep(50); // a large transfer takes a while
      return real(...args);
    };
    for (let i = 0; i < 50; i++) loop.b.send({ type: 'meme-want', memeId: meme.id });
    await settle([A, B]);
    await sleep(80);
    expect(calls).toBe(1);
  });

  it('ignores far-future message ids and read markers (they would pin the watermarks forever)', async () => {
    const { A, B, loop } = await pair();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const authorId = A.svc.pairing.profile.get()!.deviceId;
    loop.a.send({ type: 'msg', message: { id: FAR_FUTURE_ID, authorId, kind: 'text', text: 'from the future', createdAt: Date.now() } });
    await settle([A, B]);
    expect(B.svc.chat.messages.get().map((m) => m.text)).not.toContain('from the future');
    // No ack: an honest partner with a broken clock retries from its outbox later.
    expect(loop.b.sent.some((f) => f.type === 'ack' && f.ids.includes(FAR_FUTURE_ID))).toBe(false);

    await B.svc.chat.sendText('hello');
    await settle([A, B]);
    loop.a.send({ type: 'read', upToId: FAR_FUTURE_ID });
    await settle([A, B]);
    const mine = B.svc.chat.messages.get().filter((m) => m.mine);
    expect(mine.at(-1)!.status).toBe('delivered');
  });
});

describe('crafted backup files', () => {
  it('skips SVG memes even when the bytes match the id', async () => {
    const { A } = await pair();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await sha256Hex(SVG);
    const file = {
      format: BACKUP_FORMAT,
      v: BACKUP_VERSION,
      exportedAt: Date.now(),
      profile: null,
      settings: {},
      messages: [],
      memes: [{ id, mime: 'image/svg+xml', width: 1, height: 1, size: SVG.byteLength, source: 'upload', savedAt: 1, favorite: true, data: toBase64Url(SVG) }],
    };
    const res = await A.svc.backup.importBackup(new Blob([JSON.stringify(file).replace(/^\{/, '{"__proto__":{"polluted":true},')]));
    expect(res.memes).toBe(0);
    expect(await A.svc.library.get(id)).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('never hands out a document-typed blob: URL, even for rows stored before the allow-list', async () => {
    const { A } = await pair();
    const id = await sha256Hex(SVG);
    await rawDb(A.dbName, async (db) => {
      await db.memes.put({ id, mime: 'image/svg+xml', width: 1, height: 1, size: SVG.byteLength, source: 'upload', savedAt: 1, fav: 0, has: 1 });
      await db.memeData.put({ id, mime: 'image/svg+xml', data: SVG.slice().buffer });
    });
    const url = await A.svc.library.getUrl(id);
    expect(url).toMatch(/^blob:/);
    expect(resolveObjectURL(url!)?.type).toBe('application/octet-stream');
  });
});
