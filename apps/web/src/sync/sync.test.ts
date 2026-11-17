import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, ulid } from '@memes/shared';
import type { ChatMessage } from '../contracts';
import { createLoopbackPair } from '../testing/loopback';
import {
  mulberry32,
  openDevice,
  pairedDevices,
  randomImage,
  rawDb,
  settle,
  sleep,
  uniqueDbName,
  waitFor,
  type Device,
} from './testkit';

const open: Device[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((d) => d.svc.dispose()));
});

async function pair(opts: Parameters<typeof pairedDevices>[0] = {}) {
  const p = await pairedDevices(opts);
  open.push(p.A, p.B);
  return p;
}

const msgs = (d: Device) => d.svc.chat.messages.get();
const texts = (d: Device) => msgs(d).map((m) => m.text);
const last = (d: Device): ChatMessage => msgs(d)[msgs(d).length - 1]!;
const pngBlob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });

describe('pairing', () => {
  it('A creates a code, B accepts it, both connect and learn each other', async () => {
    const { A, B, code } = await pair();
    expect(code).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    const pa = A.svc.pairing.profile.get()!;
    const pb = B.svc.pairing.profile.get()!;
    expect(pa.paired).toBe(true);
    expect(pb.paired).toBe(true);
    expect(pa.pairingCode).toBe(code);
    expect(pb.pairingCode).toBe(code);
    expect(pa.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(pa.deviceId).not.toBe(pb.deviceId);
    // Same secret → same relay room on both sides.
    expect(A.calls).toHaveLength(1);
    expect(B.calls).toHaveLength(1);
    expect(A.calls[0]!.keys.roomId).toBe(B.calls[0]!.keys.roomId);
    expect(A.calls[0]!.relayUrl).toBe('http://relay.test');
    expect(A.calls[0]!.deviceId).toBe(pa.deviceId);
    expect(A.svc.chat.connection.get()).toBe('connected');
    expect(pa.partnerName).toBe('Bob');
    expect(pa.partnerDeviceId).toBe(pb.deviceId);
    expect(pb.partnerName).toBe('Alice');
  });

  it('rejects malformed codes', async () => {
    const loop = createLoopbackPair();
    const B = await openDevice(loop.b);
    open.push(B);
    await B.svc.pairing.setDisplayName('Bob');
    await expect(B.svc.pairing.acceptPairing('not a code')).rejects.toThrow('invalid-code');
    await expect(B.svc.pairing.acceptPairing('ZZZZ-ZZZZ')).rejects.toThrow('invalid-code');
    expect(B.svc.pairing.profile.get()!.paired).toBe(false);
    expect(B.calls).toHaveLength(0);
  });

  it('starts the transport on startup when already paired, recreates it on relayUrl change', async () => {
    const { A, B, loop } = await pair();
    await A.svc.dispose();
    open.splice(open.indexOf(A), 1);
    const A2 = await openDevice(loop.a, A.dbName);
    open.push(A2);
    expect(A2.calls).toHaveLength(1);
    await settle([A2, B]);
    expect(A2.svc.chat.connection.get()).toBe('connected');

    await A2.svc.settings.update({ relayUrl: 'https://relay.example.com' });
    expect(A2.calls).toHaveLength(2);
    expect(A2.calls[1]!.relayUrl).toBe('https://relay.example.com');
    expect(A2.svc.settings.settings.get()).toMatchObject({ relayUrl: 'https://relay.example.com', theme: 'system', hideNsfw: true });
    await settle([A2, B]);
    expect(A2.svc.chat.connection.get()).toBe('connected');
    // Unrelated settings do not restart.
    await A2.svc.settings.update({ theme: 'dark' });
    expect(A2.calls).toHaveLength(2);
  });

  it('unpair stops the transport and forgets the secret but keeps history', async () => {
    const { A, B } = await pair();
    await A.svc.chat.sendText('keep me');
    await settle([A, B]);
    await A.svc.pairing.unpair();
    expect(A.svc.pairing.profile.get()).toMatchObject({ paired: false, partnerName: 'Bob' });
    expect(A.svc.pairing.profile.get()!.pairingCode).toBeUndefined();
    expect(A.svc.chat.connection.get()).toBe('idle');
    expect(texts(A)).toEqual(['keep me']);
    expect(await rawDb(A.dbName, async (db) => (await db.profile.get('me'))!.secret)).toBeUndefined();
  });
});

describe('chat', () => {
  it('sends text both ways with delivered/read status and unread counts', async () => {
    const { A, B } = await pair();
    await A.svc.chat.sendText('hi Bob');
    await settle([A, B]);
    expect(texts(B)).toEqual(['hi Bob']);
    expect(last(A)).toMatchObject({ mine: true, status: 'delivered', text: 'hi Bob' });
    expect(last(B)).toMatchObject({ mine: false });
    expect(B.svc.chat.unreadCount.get()).toBe(1);

    B.svc.chat.markRead();
    await settle([A, B]);
    expect(B.svc.chat.unreadCount.get()).toBe(0);
    expect(last(A).status).toBe('read');

    await B.svc.chat.sendText('hey Alice', last(B).id);
    await B.svc.chat.sendText('second');
    await settle([A, B]);
    expect(texts(A)).toEqual(['hi Bob', 'hey Alice', 'second']);
    expect(A.svc.chat.unreadCount.get()).toBe(2);
    expect(msgs(A)[1]!.replyPreview).toMatchObject({ text: 'hi Bob', mine: true, kind: 'text' });
    expect(msgs(B)[1]!.replyPreview).toMatchObject({ text: 'hi Bob', mine: false });
    expect(msgs(B).slice(1).map((m) => m.status)).toEqual(['delivered', 'delivered']);
    // Identical message sets on both sides.
    expect(msgs(A).map((m) => m.id)).toEqual(msgs(B).map((m) => m.id));
  });

  it('rejects empty text and unknown memes', async () => {
    const { A } = await pair();
    await expect(A.svc.chat.sendText('   ')).rejects.toThrow('empty-message');
    await expect(A.svc.chat.sendMeme('a'.repeat(64))).rejects.toThrow('unknown-meme');
  });

  it('folds reactions: one per author per target, same emoji toggles off', async () => {
    const { A, B } = await pair();
    await A.svc.chat.sendText('react to me');
    await settle([A, B]);
    const id = last(A).id;

    await B.svc.chat.react(id, '👍');
    await settle([A, B]);
    expect(last(A).reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect(last(B).reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);

    await A.svc.chat.react(id, '👍');
    await settle([A, B]);
    expect(last(B).reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);

    await B.svc.chat.react(id, '👍'); // toggle off
    await settle([A, B]);
    expect(last(A).reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);

    await B.svc.chat.react(id, '❤️');
    await B.svc.chat.react(id, '😂'); // replaces B's ❤️
    await settle([A, B]);
    expect(last(A).reactions).toEqual([
      { emoji: '👍', count: 1, mine: true },
      { emoji: '😂', count: 1, mine: false },
    ]);
    await A.svc.chat.react(id, '');
    await settle([A, B]);
    expect(last(B).reactions).toEqual([{ emoji: '😂', count: 1, mine: true }]);
    // Reactions never show up as chat items.
    expect(msgs(A)).toHaveLength(1);
    expect(A.svc.chat.unreadCount.get()).toBe(0);
  });

  it('typing indicator auto-expires and clears on message', async () => {
    const { A, B } = await pair();
    B.svc.chat.setTyping(true);
    await waitFor(() => A.svc.chat.partnerTyping.get(), 1000, 'typing');
    await waitFor(() => !A.svc.chat.partnerTyping.get(), 1000, 'typing expiry');

    B.svc.chat.setTyping(false); // last sent was true → sends false
    B.svc.chat.setTyping(true);
    await waitFor(() => A.svc.chat.partnerTyping.get(), 1000, 'typing again');
    await B.svc.chat.sendText('done typing');
    await settle([A, B]);
    expect(A.svc.chat.partnerTyping.get()).toBe(false);

    B.svc.chat.setTyping(true);
    await waitFor(() => A.svc.chat.partnerTyping.get(), 1000, 'typing 3');
    B.svc.chat.setTyping(false);
    await settle([A, B]);
    expect(A.svc.chat.partnerTyping.get()).toBe(false);
  });

  it('propagates renames', async () => {
    const { A, B } = await pair();
    await A.svc.pairing.setDisplayName('Alicia');
    await settle([A, B]);
    expect(B.svc.pairing.profile.get()!.partnerName).toBe('Alicia');
    expect(A.svc.pairing.profile.get()!.displayName).toBe('Alicia');
  });

  it('keeps offline messages pending in the outbox and flushes them on link()', async () => {
    const { A, B, loop } = await pair();
    loop.unlink();
    await settle([A, B]);
    expect(A.svc.chat.connection.get()).toBe('waiting');
    await A.svc.chat.sendText('one');
    await A.svc.chat.sendText('two');
    await B.svc.chat.sendText('from B offline');
    expect(msgs(A).map((m) => m.status)).toEqual(['pending', 'pending']);
    expect(await rawDb(A.dbName, (db) => db.outbox.count())).toBe(2);
    expect(msgs(B)).toHaveLength(1);

    loop.link();
    await settle([A, B]);
    expect(new Set(texts(A))).toEqual(new Set(['one', 'two', 'from B offline']));
    expect(msgs(B).map((m) => m.id)).toEqual(msgs(A).map((m) => m.id));
    expect(msgs(A).filter((m) => m.mine).map((m) => m.status)).toEqual(['delivered', 'delivered']);
    expect(await rawDb(A.dbName, (db) => db.outbox.count())).toBe(0);
    expect(await rawDb(B.dbName, (db) => db.outbox.count())).toBe(0);
  });

  it('ignores msg frames that spoof our deviceId', async () => {
    const { A, B, loop } = await pair();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const me = A.svc.pairing.profile.get()!.deviceId;
    loop.b.send({ type: 'msg', message: { id: ulid(), authorId: me, kind: 'text', text: 'fake', createdAt: Date.now() } });
    loop.b.send({ type: 'hello', v: 1, deviceId: me, displayName: 'evil', lastReceivedId: null, lastReadId: null });
    await settle([A, B]);
    expect(msgs(A)).toHaveLength(0);
    expect(A.svc.pairing.profile.get()!.partnerName).toBe('Bob');
    expect(warn).toHaveBeenCalled();
  });

  it('pages older messages with loadOlder()', async () => {
    const loop = createLoopbackPair();
    const dbName = uniqueDbName('page');
    const A = await openDevice(loop.a, dbName, { pageSize: 10 });
    await A.svc.pairing.setDisplayName('Alice');
    for (let i = 0; i < 25; i++) await A.svc.chat.sendText(`m${i}`);
    await A.svc.chat.react(msgs(A)[0]!.id, '🔥'); // on m0, which is outside the first page after reload
    await A.svc.dispose();

    const A2 = await openDevice(loop.a, dbName, { pageSize: 10 });
    open.push(A2);
    expect(texts(A2)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 15}`));
    expect(await A2.svc.chat.loadOlder()).toBe(true);
    expect(texts(A2)).toHaveLength(20);
    expect(await A2.svc.chat.loadOlder()).toBe(true);
    expect(texts(A2)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
    expect(msgs(A2)[0]!.reactions).toEqual([{ emoji: '🔥', count: 1, mine: true }]);
    expect(await A2.svc.chat.loadOlder()).toBe(false);
    // Earlier items keep their object identity when new ones arrive (incremental updates).
    const before = msgs(A2);
    await A2.svc.chat.sendText('new');
    expect(msgs(A2)[0]).toBe(before[0]);
    expect(msgs(A2)).toHaveLength(26);
  });
});

describe('memes', () => {
  it('transfers meme bytes end to end and rejects a tampered blob', async () => {
    const { A, B, loop } = await pair();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bytes = randomImage(5000, 7);
    const meme = await A.svc.library.importImage({ blob: pngBlob(bytes), mime: 'image/png', width: 10, height: 20, source: 'upload', title: 'Cat' });
    expect(meme.id).toBe(await sha256Hex(bytes));
    expect(meme.size).toBe(5000);
    // Dedupe by content.
    const again = await A.svc.library.importImage({ blob: pngBlob(bytes), mime: 'image/png', width: 10, height: 20, source: 'reddit' });
    expect(again).toEqual(meme);
    expect(await A.svc.library.list()).toHaveLength(1);

    // Tamper with the first transfer.
    const realSendBlob = loop.a.sendBlob.bind(loop.a);
    loop.a.sendBlob = (id, mime, data) => {
      const bad = data.slice();
      bad[0] ^= 0xff;
      return realSendBlob(id, mime, bad);
    };
    await A.svc.chat.sendMeme(meme.id, 'look');
    await settle([A, B]);
    expect(last(B)).toMatchObject({ kind: 'meme', memeId: meme.id, text: 'look' });
    expect(await B.svc.library.getUrl(meme.id)).toBeNull();
    expect(await B.svc.library.get(meme.id)).toMatchObject({ width: 10, height: 20, title: 'Cat' });
    expect(await B.svc.library.list()).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('hash mismatch'))).toBe(true);

    // A lying mime is rejected too.
    loop.a.sendBlob = (id, _mime, data) => realSendBlob(id, 'image/gif', data);
    loop.unlink();
    loop.link();
    await settle([A, B]);
    expect(await B.svc.library.getUrl(meme.id)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('mime'))).toBe(true);

    // Honest transfer after reconnect: the missing meme is re-requested.
    loop.a.sendBlob = realSendBlob;
    const v0 = B.svc.library.version.get();
    loop.unlink();
    loop.link();
    await settle([A, B]);
    const url = await B.svc.library.getUrl(meme.id);
    expect(url).toMatch(/^(blob:|data:)/);
    expect(await B.svc.library.getUrl(meme.id)).toBe(url); // cached
    expect(B.svc.library.version.get()).toBeGreaterThan(v0);
    const got = await B.svc.library.list();
    expect(got.map((m) => m.id)).toEqual([meme.id]);
    const stored = await rawDb(B.dbName, (db) => db.memeData.get(meme.id));
    expect(stored!.data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(stored!.data)).toEqual(bytes);
  });

  it('re-requests missing memes after an app reload', async () => {
    const { A, B, loop } = await pair();
    const realSendBlob = loop.a.sendBlob.bind(loop.a);
    loop.a.sendBlob = async () => {}; // drop the bytes
    const meme = await A.svc.library.importImage({ blob: pngBlob(randomImage(3000, 3)), mime: 'image/png', width: 1, height: 1, source: 'maker' });
    await A.svc.chat.sendMeme(meme.id);
    await settle([A, B]);
    expect(await B.svc.library.getUrl(meme.id)).toBeNull();

    await B.svc.dispose();
    open.splice(open.indexOf(B), 1);
    loop.a.sendBlob = realSendBlob;
    const B2 = await openDevice(loop.b, B.dbName);
    open.push(B2);
    await settle([A, B2]);
    expect(await B2.svc.library.getUrl(meme.id)).not.toBeNull();
    expect(last(B2).memeId).toBe(meme.id);
  });

  it('answers meme-want for unknown memes with meme-missing', async () => {
    const { A, B, loop } = await pair();
    loop.b.send({ type: 'meme-want', memeId: 'b'.repeat(64) });
    await settle([A, B]);
    expect(loop.a.sent).toContainEqual({ type: 'meme-missing', memeId: 'b'.repeat(64) });
  });

  it('lists, searches, favorites and removes', async () => {
    const loop = createLoopbackPair();
    const A = await openDevice(loop.a);
    open.push(A);
    const add = async (seed: number, title: string) => {
      const m = await A.svc.library.importImage({ blob: pngBlob(randomImage(100, seed)), mime: 'image/png', width: 1, height: 1, source: 'imgflip', title });
      await sleep(2);
      return m;
    };
    const m1 = await add(1, 'Distracted boyfriend');
    const m2 = await add(2, 'Drake');
    const m3 = await add(3, 'Galaxy brain');
    expect((await A.svc.library.list()).map((m) => m.id)).toEqual([m3.id, m2.id, m1.id]);
    expect((await A.svc.library.list({ limit: 2 })).map((m) => m.id)).toEqual([m3.id, m2.id]);
    expect((await A.svc.library.list({ query: 'DRA' })).map((m) => m.id)).toEqual([m2.id]);
    expect(await A.svc.library.toggleFavorite(m1.id)).toBe(true);
    expect((await A.svc.library.list({ favoritesOnly: true })).map((m) => m.id)).toEqual([m1.id]);
    expect(await A.svc.library.toggleFavorite(m1.id)).toBe(false);
    expect(await A.svc.library.list({ favoritesOnly: true })).toEqual([]);
    const url = await A.svc.library.getUrl(m2.id);
    expect(url).not.toBeNull();
    const v = A.svc.library.version.get();
    await A.svc.library.remove(m2.id);
    expect(A.svc.library.version.get()).toBe(v + 1);
    expect(await A.svc.library.getUrl(m2.id)).toBeNull();
    expect(await A.svc.library.get(m2.id)).toBeUndefined();
    await expect(
      A.svc.library.importImage({ blob: pngBlob(randomImage(10)), mime: 'text/html', width: 1, height: 1, source: 'upload' }),
    ).rejects.toThrow('invalid-mime');
  });
});

describe('backup and wipe', () => {
  it('exports a backup and imports it into a fresh DB (idempotently)', async () => {
    const { A, B } = await pair();
    const meme = await A.svc.library.importImage({ blob: pngBlob(randomImage(800, 9)), mime: 'image/webp', width: 4, height: 4, source: 'upload', title: 'keeper' });
    await A.svc.library.toggleFavorite(meme.id);
    await A.svc.chat.sendText('hello');
    await A.svc.chat.sendMeme(meme.id, 'cap');
    await B.svc.chat.sendText('reply');
    await settle([A, B]);
    await A.svc.chat.react(last(A).id, '👍');
    await A.svc.settings.update({ theme: 'dark', subreddits: ['memes', 'bad sub!'] });
    await settle([A, B]);

    const file = await A.svc.backup.exportBackup();
    expect(file.type).toBe('application/json');
    const json = JSON.parse(await file.text());
    expect(json).toMatchObject({ format: 'meme-pals-backup', v: 1 });
    expect(typeof json.exportedAt).toBe('number');
    expect(json.messages).toHaveLength(4);
    expect(json.memes).toHaveLength(1);
    expect(json.settings).toMatchObject({ theme: 'dark', subreddits: ['memes'] });
    const secret = await rawDb(A.dbName, async (db) => (await db.profile.get('me'))!.secret!);
    expect(secret).toBeTruthy();
    expect(JSON.stringify(json)).not.toContain(secret);
    expect(json.profile.secret).toBeUndefined();

    // Restore on a "new phone": onboarding first, then import.
    const C = await openDevice(createLoopbackPair().a, uniqueDbName('restore'));
    open.push(C);
    await C.svc.pairing.setDisplayName('Alice (new phone)');
    const res = await C.svc.backup.importBackup(file);
    expect(res).toEqual({ messages: 4, memes: 1 });
    const pc = C.svc.pairing.profile.get()!;
    expect(pc).toMatchObject({ deviceId: A.svc.pairing.profile.get()!.deviceId, paired: false, partnerName: 'Bob' });
    expect(msgs(C).map((m) => [m.text, m.mine, m.status])).toEqual(msgs(A).map((m) => [m.text, m.mine, m.status]));
    expect(last(C).reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    expect(await C.svc.library.list({ favoritesOnly: true })).toMatchObject([{ id: meme.id, title: 'keeper' }]);
    expect(await C.svc.library.getUrl(meme.id)).not.toBeNull();
    expect(C.svc.settings.settings.get().theme).toBe('dark');

    // Second import is a no-op.
    expect(await C.svc.backup.importBackup(file)).toEqual({ messages: 0, memes: 0 });
    expect(msgs(C)).toHaveLength(3);

    // Garbage is rejected; corrupt meme bytes are imported as "missing".
    await expect(C.svc.backup.importBackup(new Blob(['{"format":"nope"}']))).rejects.toThrow('invalid-backup');
    const tampered = { ...json, memes: [{ ...json.memes[0], data: json.memes[0].data.slice(4) }], messages: [...json.messages, { id: 'bad' }] };
    const D = await openDevice(createLoopbackPair().a, uniqueDbName('restore2'));
    open.push(D);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await D.svc.backup.importBackup(new Blob([JSON.stringify(tampered)]))).toEqual({ messages: 4, memes: 0 });
    expect(await D.svc.library.getUrl(meme.id)).toBeNull();
    expect(await D.svc.library.get(meme.id)).toMatchObject({ id: meme.id });
  });

  it('wipe deletes everything and resets every readable', async () => {
    const { A, B } = await pair();
    const meme = await A.svc.library.importImage({ blob: pngBlob(randomImage(64)), mime: 'image/png', width: 1, height: 1, source: 'upload' });
    await A.svc.chat.sendMeme(meme.id);
    await B.svc.chat.sendText('unread');
    await A.svc.settings.update({ theme: 'light' });
    await settle([A, B]);
    expect(A.svc.chat.unreadCount.get()).toBe(1);
    const v = A.svc.library.version.get();

    await A.svc.pairing.wipe();
    expect(A.svc.pairing.profile.get()).toBeNull();
    expect(msgs(A)).toEqual([]);
    expect(A.svc.chat.unreadCount.get()).toBe(0);
    expect(A.svc.chat.connection.get()).toBe('idle');
    expect(A.svc.chat.partnerTyping.get()).toBe(false);
    expect(A.svc.settings.settings.get().theme).toBe('system');
    expect(A.svc.library.version.get()).toBeGreaterThan(v);
    expect(await A.svc.library.list()).toEqual([]);
    expect(await A.svc.library.getUrl(meme.id)).toBeNull();

    // Usable again afterwards (fresh identity).
    await A.svc.pairing.setDisplayName('Alice again');
    expect(A.svc.pairing.profile.get()!.deviceId).not.toBe(B.svc.pairing.profile.get()!.partnerDeviceId);
  });
});

describe('convergence', () => {
  it.each([1, 2, 3])('converges under random sends and link flapping (seed %i)', async (seed) => {
    const rnd = mulberry32(seed);
    const { A, B, loop } = await pair({ linked: rnd() < 0.5 });
    const devs = [A, B];
    let sentCount = 0;
    for (let step = 0; step < 150; step++) {
      const r = rnd();
      const d = devs[rnd() < 0.5 ? 0 : 1]!;
      if (r < 0.12) loop.link();
      else if (r < 0.24) loop.unlink();
      else if (r < 0.32) {
        const list = msgs(d);
        if (list.length) await d.svc.chat.react(list[Math.floor(rnd() * list.length)]!.id, rnd() < 0.5 ? '👍' : '😂');
      } else if (r < 0.4) {
        await sleep(Math.floor(rnd() * 3));
      } else {
        // Not always awaited: lets sends interleave with incoming frames and link changes.
        const p = d.svc.chat.sendText(`s${seed}-${step}`);
        sentCount++;
        if (rnd() < 0.7) await p;
      }
    }
    loop.link();
    await settle([A, B]);

    const dump = (name: string) =>
      rawDb(name, async (db) => ({
        ids: (await db.messages.toCollection().primaryKeys()).sort(),
        outbox: await db.outbox.count(),
        undelivered: await db.messages.filter((m) => m.deliveredAt === undefined && m.receivedAt === undefined).count(),
      }));
    const da = await dump(A.dbName);
    const db = await dump(B.dbName);
    expect(da.ids).toEqual(db.ids);
    expect(da.outbox).toBe(0);
    expect(db.outbox).toBe(0);
    expect(da.undelivered).toBe(0);
    expect(db.undelivered).toBe(0);
    const chatA = msgs(A);
    expect(chatA.length).toBe(sentCount);
    expect(chatA.map((m) => m.id)).toEqual(msgs(B).map((m) => m.id));
    expect(chatA.filter((m) => m.mine && m.status === 'pending')).toEqual([]);
    expect(chatA.map((m) => JSON.stringify(m.reactions.map((x) => [x.emoji, x.count])))).toEqual(
      msgs(B).map((m) => JSON.stringify(m.reactions.map((x) => [x.emoji, x.count]))),
    );
  });
});
