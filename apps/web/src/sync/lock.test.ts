import 'fake-indexeddb/auto';
import { resolveObjectURL } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@memes/shared';
import { createLoopbackPair, type LoopbackTransport } from '../testing/loopback';
import { isEncryptedField } from '../db/atRest';
import { BACKOFF_STEPS_MS, backoffMs } from '../db/lock';
import type { EngineTuning, VisibilitySource } from './engine';
import { openDevice, pairedDevices, randomImage, rawDb, settle, uniqueDbName, waitFor, type Device } from './testkit';

/**
 * Passcode lock (A8): at-rest encryption, locked state, back-off, auto-lock, partner pinning.
 * PBKDF2 runs with 1,000 iterations here so the suite stays fast.
 */

const FAST: EngineTuning = { kdfIterations: 1000, visibility: null };
const PASS = '482915';
const NEW_PASS = 'correct horse battery';

const open: Device[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((d) => d.svc.dispose()));
});

async function pair(tuning: EngineTuning = {}) {
  const p = await pairedDevices({ tuning: { ...FAST, ...tuning } });
  open.push(p.A, p.B);
  return p;
}

/** Close a device and open its DB again (an app reload). */
async function reload(d: Device, transport: LoopbackTransport, tuning: EngineTuning = {}): Promise<Device> {
  await d.svc.dispose();
  open.splice(open.indexOf(d), 1);
  const again = await openDevice(transport, d.dbName, { ...FAST, ...tuning });
  open.push(again);
  return again;
}

const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('hex');

/** Every row of every table, serialized (ArrayBuffers as hex) so plaintext can be searched. */
async function rawDump(dbName: string): Promise<string> {
  return rawDb(dbName, async (db) => {
    const parts: string[] = [];
    for (const t of db.tables) {
      for (const row of await t.toArray()) {
        parts.push(
          JSON.stringify(row, (_k, v) => (v instanceof ArrayBuffer ? `<bytes:${hex(v)}>` : v)),
        );
      }
    }
    return parts.join('\n');
  });
}

const texts = (d: Device) => d.svc.chat.messages.get().map((m) => m.text);
const pngBlob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });

const ALICE = 'Alice Liddell-QX';
const BOB = 'Bobby Tables-QX';

async function seedHistory(A: Device, B: Device) {
  await A.svc.pairing.setDisplayName(ALICE);
  await B.svc.pairing.setDisplayName(BOB);
  const image = randomImage(3000, 7);
  const meme = await A.svc.library.importImage({
    blob: pngBlob(image),
    mime: 'image/png',
    width: 10,
    height: 10,
    source: 'reddit',
    title: 'TITLE-secret-cat',
    sourceUrl: 'https://www.reddit.com/r/memes/comments/SOURCE-secret/',
  });
  await A.svc.chat.sendText('TEXT-alpha-from-alice');
  await A.svc.chat.sendMeme(meme.id, 'CAPTION-beta');
  await B.svc.chat.sendText('TEXT-gamma-from-bob');
  await settle([A, B]);
  const target = A.svc.chat.messages.get().find((m) => m.text === 'TEXT-gamma-from-bob')!;
  await A.svc.chat.react(target.id, '🦄');
  await settle([A, B]);
  return { image, meme };
}

describe('enable: encryption at rest', () => {
  it('leaves no plaintext text, names, secret, meme bytes or meme title in IndexedDB', async () => {
    const { A, B, code } = await pair();
    const { image } = await seedHistory(A, B);
    const secret = (await rawDb(A.dbName, (db) => db.profile.get('me')))!.secret!;
    const before = await rawDump(A.dbName);
    for (const s of ['TEXT-alpha', 'TEXT-gamma', 'CAPTION-beta', 'TITLE-secret', 'SOURCE-secret', ALICE, BOB, '🦄', secret]) {
      expect(before).toContain(s); // sanity: the probe would find them
    }
    expect(before).toContain(hex(image.subarray(100, 164)));

    await A.svc.lock.enable(PASS);
    expect(A.svc.lock.state.get()).toBe('unlocked');

    const after = await rawDump(A.dbName);
    for (const s of ['TEXT-alpha', 'TEXT-gamma', 'CAPTION-beta', 'TITLE-secret', 'SOURCE-secret', ALICE, BOB, '🦄', secret, code, code.replace(/-/g, '')]) {
      expect(after).not.toContain(s);
    }
    expect(after).not.toContain(hex(image.subarray(100, 164)));

    // Index and key fields stay plaintext (sync and queries need them).
    const raw = await rawDb(A.dbName, async (db) => ({
      profile: (await db.profile.get('me'))!,
      messages: await db.messages.toArray(),
      memes: await db.memes.toArray(),
      data: await db.memeData.toArray(),
      lock: await db.lock.get('lock'),
    }));
    expect(raw.profile.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(isEncryptedField(raw.profile.secret)).toBe(true);
    expect(isEncryptedField(raw.profile.displayName)).toBe(true);
    expect(isEncryptedField(raw.profile.partnerName)).toBe(true);
    for (const m of raw.messages) {
      expect(m.id).toMatch(/^[0-9A-Z]{26}$/);
      if (m.text !== undefined) expect(isEncryptedField(m.text)).toBe(true);
      if (m.emoji !== undefined) expect(isEncryptedField(m.emoji)).toBe(true);
    }
    expect(raw.memes[0]).toMatchObject({ mime: 'image/png', has: 1, size: 3000 });
    expect(isEncryptedField(raw.memes[0]!.title)).toBe(true);
    expect(isEncryptedField(raw.data[0]!.data)).toBe(true);
    expect(raw.lock).toMatchObject({ kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000 }, failures: 0 });
    expect(raw.lock!.migrating).toBeUndefined();

    // Still works while unlocked: new rows are encrypted too, and sync carries on.
    await A.svc.chat.sendText('TEXT-delta-after-enable');
    await settle([A, B]);
    expect(texts(B)).toContain('TEXT-delta-after-enable');
    expect(texts(A)).toContain('TEXT-gamma-from-bob');
    expect(await rawDump(A.dbName)).not.toContain('TEXT-delta');
  });

  it('rejects weak passcodes and a second enable', async () => {
    const { A } = await pair();
    await expect(A.svc.lock.enable('123')).rejects.toThrow('weak-passcode');
    await expect(A.svc.lock.enable('  ')).rejects.toThrow('weak-passcode');
    expect(A.svc.lock.state.get()).toBe('disabled');
    await A.svc.lock.enable('1234');
    await expect(A.svc.lock.enable(PASS)).rejects.toThrow('already-enabled');
  });

  it('binds ciphertext to its row and field: a swapped value reads as missing, never as the other text', async () => {
    const { A, B, loop } = await pair();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await A.svc.chat.sendText('first-message');
    await A.svc.chat.sendText('second-message');
    await settle([A, B]);
    await A.svc.lock.enable(PASS);
    await rawDb(A.dbName, async (db) => {
      const [m1, m2] = await db.messages.orderBy('id').toArray();
      await db.messages.put({ ...m2!, text: m1!.text });
    });
    const A2 = await reload(A, loop.a);
    await A2.svc.lock.unlock(PASS);
    expect(texts(A2)).toEqual(['first-message', undefined]);
  });
});

describe('locked state', () => {
  it('starts locked after a reload, loads nothing and starts no transport until unlock', async () => {
    const { A, B, loop } = await pair();
    await seedHistory(A, B);
    await A.svc.lock.enable(PASS);

    loop.unlink();
    await B.svc.chat.sendText('sent-while-A-was-locked');
    const A2 = await reload(A, loop.a);
    expect(A2.svc.lock.state.get()).toBe('locked');
    expect(A2.svc.pairing.profile.get()).toBeNull();
    expect(A2.svc.chat.messages.get()).toEqual([]);
    expect(A2.svc.chat.connection.get()).toBe('idle');
    expect(A2.calls).toHaveLength(0);
    loop.link();
    await settle([A2, B]);
    expect(A2.svc.chat.messages.get()).toEqual([]);

    await expect(A2.svc.lock.unlock('000000')).rejects.toThrow('wrong-passcode');
    expect(A2.svc.lock.state.get()).toBe('locked');
    await A2.svc.lock.unlock(PASS);
    expect(A2.svc.lock.state.get()).toBe('unlocked');
    expect(A2.svc.pairing.profile.get()).toMatchObject({ displayName: ALICE, partnerName: BOB, paired: true });
    expect(A2.calls).toHaveLength(1);
    await settle([A2, B]);
    expect(texts(A2)).toEqual(['TEXT-alpha-from-alice', 'CAPTION-beta', 'TEXT-gamma-from-bob', 'sent-while-A-was-locked']);
    expect(A2.svc.chat.messages.get().find((m) => m.text === 'TEXT-gamma-from-bob')!.reactions).toEqual([{ emoji: '🦄', count: 1, mine: true }]);

    await A2.svc.chat.sendText('after-unlock');
    await settle([A2, B]);
    expect(texts(B)).toContain('after-unlock');
    expect(B.svc.chat.messages.get().find((m) => m.text === 'after-unlock')!.status).toBe('delivered');
  });

  it('meme bytes and metadata come back after unlock', async () => {
    const { A, B, loop } = await pair();
    const { image, meme } = await seedHistory(A, B);
    await A.svc.lock.enable(PASS);
    const A2 = await reload(A, loop.a);
    await A2.svc.lock.unlock(PASS);
    expect(await A2.svc.library.get(meme.id)).toMatchObject({ title: 'TITLE-secret-cat', sourceUrl: expect.stringContaining('SOURCE-secret') });
    expect((await A2.svc.library.list({ query: 'secret-cat' })).map((m) => m.id)).toEqual([meme.id]);
    const url = await A2.svc.library.getUrl(meme.id);
    const bytes = new Uint8Array(await resolveObjectURL(url!)!.arrayBuffer());
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(image));
  });

  it('blocks chat, library, pairing and settings while locked; only wipe works', async () => {
    const { A, B } = await pair();
    const { meme } = await seedHistory(A, B);
    await A.svc.lock.enable(PASS);
    await A.svc.lock.lockNow();
    const svc = A.svc;
    const calls: [string, () => Promise<unknown>][] = [
      ['sendText', () => svc.chat.sendText('nope')],
      ['sendMeme', () => svc.chat.sendMeme(meme.id)],
      ['react', () => svc.chat.react('x', '👍')],
      ['loadOlder', () => svc.chat.loadOlder()],
      ['importImage', () => svc.library.importImage({ blob: pngBlob(randomImage(10)), mime: 'image/png', width: 1, height: 1, source: 'upload' })],
      ['get', () => svc.library.get(meme.id)],
      ['getUrl', () => svc.library.getUrl(meme.id)],
      ['list', () => svc.library.list()],
      ['toggleFavorite', () => svc.library.toggleFavorite(meme.id)],
      ['remove', () => svc.library.remove(meme.id)],
      ['setDisplayName', () => svc.pairing.setDisplayName('Mallory')],
      ['createPairing', () => svc.pairing.createPairing()],
      ['acceptPairing', () => svc.pairing.acceptPairing('not a code')],
      ['unpair', () => svc.pairing.unpair()],
      ['settings.update', () => svc.settings.update({ theme: 'dark' })],
      ['exportBackup', () => svc.backup.exportBackup({ password: 'backup-pass-123' })],
      ['disable', () => svc.lock.disable(PASS)],
      ['change', () => svc.lock.change(PASS, NEW_PASS)],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toThrow('locked');
    }
    // Fire-and-forget calls are silent no-ops.
    svc.chat.setTyping(true);
    svc.chat.markRead();
    await svc.whenIdle();
    expect(svc.lock.state.get()).toBe('locked');

    // "Forgot passcode? Wipe this device."
    await svc.pairing.wipe();
    expect(svc.lock.state.get()).toBe('disabled');
    expect(svc.pairing.profile.get()).toBeNull();
    expect(await rawDb(A.dbName, (db) => db.messages.count())).toBe(0);
    await svc.pairing.setDisplayName('Alice again');
    expect(svc.pairing.profile.get()!.displayName).toBe('Alice again');
  });

  it('lockNow stops syncing and forgets everything decrypted', async () => {
    const { A, B } = await pair();
    const { meme } = await seedHistory(A, B);
    await A.svc.lock.enable(PASS);
    const url = (await A.svc.library.getUrl(meme.id))!;
    expect(resolveObjectURL(url)).toBeTruthy();
    expect(A.svc.chat.connection.get()).toBe('connected');

    await A.svc.lock.lockNow();
    expect(A.svc.lock.state.get()).toBe('locked');
    expect(A.svc.chat.connection.get()).toBe('idle');
    expect(A.svc.chat.messages.get()).toEqual([]);
    expect(A.svc.chat.unreadCount.get()).toBe(0);
    expect(A.svc.pairing.profile.get()).toBeNull();
    expect(resolveObjectURL(url)).toBeUndefined();
    // Partner messages are not received while locked (they wait in B's outbox).
    await B.svc.chat.sendText('while-locked');
    await settle([A, B]);
    expect(A.svc.chat.messages.get()).toEqual([]);
    expect(await rawDb(A.dbName, (db) => db.messages.count())).toBe(4);

    await A.svc.lock.unlock(PASS);
    await settle([A, B]);
    expect(texts(A)).toContain('while-locked');
    expect(A.svc.chat.connection.get()).toBe('connected');
  });

  it('lockNow is a no-op without a passcode', async () => {
    const { A } = await pair();
    await A.svc.lock.lockNow();
    expect(A.svc.lock.state.get()).toBe('disabled');
    expect(A.svc.chat.connection.get()).toBe('connected');
  });
});

describe('attempt back-off', () => {
  it('backoffMs: 5 free attempts, then 30 s, 1 m, 5 m, 15 m and 1 h at most', () => {
    expect([0, 1, 4].map(backoffMs)).toEqual([0, 0, 0]);
    expect([5, 6, 7, 8, 9, 50].map(backoffMs)).toEqual([30_000, 60_000, 300_000, 900_000, 3_600_000, 3_600_000]);
    expect(BACKOFF_STEPS_MS.at(-1)).toBe(3_600_000);
  });

  it('counts failures, waits, survives a reload, and resets on success; never wipes', async () => {
    let now = 1_700_000_000_000;
    const clock = { now: () => now };
    const { A, loop } = await pair(clock);
    await A.svc.chat.sendText('still-here');
    await A.svc.lock.enable(PASS);
    let A2 = await reload(A, loop.a, clock);

    for (let i = 1; i <= 4; i++) {
      await expect(A2.svc.lock.unlock('wrong' + i)).rejects.toThrow('wrong-passcode');
      expect(A2.svc.lock.retryAfterMs.get()).toBe(0);
    }
    await expect(A2.svc.lock.unlock('wrong5')).rejects.toThrow('wrong-passcode');
    expect(A2.svc.lock.retryAfterMs.get()).toBe(30_000);
    // Even the right passcode is refused during the wait.
    await expect(A2.svc.lock.unlock(PASS)).rejects.toThrow('too-many-attempts');

    // A reload doesn't reset the wait or the count.
    now += 10_000;
    A2 = await reload(A2, loop.a, clock);
    expect(A2.svc.lock.retryAfterMs.get()).toBe(20_000);
    await expect(A2.svc.lock.unlock(PASS)).rejects.toThrow('too-many-attempts');
    now += 20_000;
    await expect(A2.svc.lock.unlock('wrong6')).rejects.toThrow('wrong-passcode');
    expect(A2.svc.lock.retryAfterMs.get()).toBe(60_000);
    now += 60_000;
    await expect(A2.svc.lock.unlock('wrong7')).rejects.toThrow('wrong-passcode');
    expect(A2.svc.lock.retryAfterMs.get()).toBe(300_000);

    // Data is never wiped by failures.
    expect(await rawDb(A2.dbName, (db) => db.messages.count())).toBe(1);
    now += 300_000;
    await A2.svc.lock.unlock(PASS);
    expect(texts(A2)).toEqual(['still-here']);
    expect(await rawDb(A2.dbName, (db) => db.lock.get('lock'))).toMatchObject({ failures: 0, lockedUntil: 0 });
  });

  it('records the attempt before checking it, so closing the app mid-check does not reset the count', async () => {
    const { A, loop } = await pair();
    await A.svc.lock.enable(PASS);
    const A2 = await reload(A, loop.a);
    open.splice(open.indexOf(A2), 1); // left hanging on purpose: dispose() would wait for the attempt
    vi.spyOn(globalThis.crypto.subtle, 'deriveKey').mockImplementation(() => new Promise<CryptoKey>(() => {}));
    void A2.svc.lock.unlock('wrong').catch(() => {});
    await waitFor(async () => (await rawDb(A2.dbName, (db) => db.lock.get('lock')))!.failures === 1, 3000, 'attempt recorded');
  });

  it('counts down retryAfterMs with timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const loop = createLoopbackPair();
    const A = await openDevice(loop.a, uniqueDbName('cd'), FAST);
    open.push(A);
    await A.svc.pairing.setDisplayName('Alice');
    await A.svc.lock.enable(PASS);
    await A.svc.lock.lockNow();
    for (let i = 0; i < 5; i++) await A.svc.lock.unlock('nope').catch(() => {});
    expect(A.svc.lock.retryAfterMs.get()).toBe(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(A.svc.lock.retryAfterMs.get()).toBe(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(A.svc.lock.retryAfterMs.get()).toBe(0);
  });
});

describe('change and disable', () => {
  it('change re-wraps the same key (rows untouched); the old passcode stops working', async () => {
    const { A, B, loop } = await pair();
    await seedHistory(A, B);
    await A.svc.lock.enable(PASS);
    const rowsBefore = await rawDb(A.dbName, (db) => db.messages.toArray());
    const lockBefore = (await rawDb(A.dbName, (db) => db.lock.get('lock')))!;

    await expect(A.svc.lock.change('nope', NEW_PASS)).rejects.toThrow('wrong-passcode');
    await expect(A.svc.lock.change(PASS, '12')).rejects.toThrow('weak-passcode');
    await A.svc.lock.change(PASS, NEW_PASS);
    expect(await rawDb(A.dbName, (db) => db.messages.toArray())).toEqual(rowsBefore);
    const lockAfter = (await rawDb(A.dbName, (db) => db.lock.get('lock')))!;
    expect(lockAfter.kdf!.salt).not.toBe(lockBefore.kdf!.salt);
    expect(lockAfter.wrappedKey).not.toEqual(lockBefore.wrappedKey);
    expect(lockAfter.failures).toBe(0);

    const A2 = await reload(A, loop.a);
    await expect(A2.svc.lock.unlock(PASS)).rejects.toThrow('wrong-passcode');
    await A2.svc.lock.unlock(NEW_PASS);
    expect(texts(A2)).toContain('TEXT-alpha-from-alice');
  });

  it('disable decrypts every row back to plaintext and removes the lock', async () => {
    const { A, B, loop, code } = await pair();
    const { image } = await seedHistory(A, B);
    await A.svc.lock.enable(PASS);
    await expect(A.svc.lock.disable('nope')).rejects.toThrow('wrong-passcode');
    expect(A.svc.lock.state.get()).toBe('unlocked');
    await A.svc.lock.disable(PASS);
    expect(A.svc.lock.state.get()).toBe('disabled');

    const dump = await rawDump(A.dbName);
    for (const s of ['TEXT-alpha', 'TEXT-gamma', 'CAPTION-beta', 'TITLE-secret', 'SOURCE-secret', ALICE, BOB, '🦄']) expect(dump).toContain(s);
    expect(dump).toContain(hex(image.subarray(100, 164)));
    expect(dump).not.toContain('"$enc"');
    const raw = await rawDb(A.dbName, async (db) => ({ profile: (await db.profile.get('me'))!, lock: (await db.lock.get('lock'))! }));
    expect(raw.profile.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw.lock.kdf).toBeUndefined();
    expect(raw.lock.wrappedKey).toBeUndefined();

    const A2 = await reload(A, loop.a);
    expect(A2.svc.lock.state.get()).toBe('disabled');
    expect(A2.svc.pairing.profile.get()!.pairingCode).toBe(code);
    await settle([A2, B]);
    expect(A2.svc.chat.connection.get()).toBe('connected');
  });

  it('an interrupted enable or disable is finished by the next unlock', async () => {
    const { A, B, loop } = await pair();
    await seedHistory(A, B);
    await A.svc.lock.enable(PASS);
    // Simulate a crash during enable: the record says "encrypting", one row is still plaintext.
    await rawDb(A.dbName, async (db) => {
      const m = (await db.messages.orderBy('id').first())!;
      await db.messages.put({ ...m, text: 'LEFT-IN-PLAINTEXT' });
      await db.lock.update('lock', { migrating: 'encrypt' });
    });
    let A2 = await reload(A, loop.a);
    expect(A2.svc.lock.state.get()).toBe('locked');
    await A2.svc.lock.unlock(PASS);
    expect(texts(A2)[0]).toBe('LEFT-IN-PLAINTEXT');
    expect(await rawDump(A2.dbName)).not.toContain('LEFT-IN-PLAINTEXT');
    expect((await rawDb(A2.dbName, (db) => db.lock.get('lock')))!.migrating).toBeUndefined();

    // A crash during disable: still locked on start; unlocking completes the disable.
    await rawDb(A2.dbName, (db) => db.lock.update('lock', { migrating: 'decrypt' }));
    A2 = await reload(A2, loop.a);
    expect(A2.svc.lock.state.get()).toBe('locked');
    await A2.svc.lock.unlock(PASS);
    expect(A2.svc.lock.state.get()).toBe('disabled');
    expect(await rawDump(A2.dbName)).toContain('LEFT-IN-PLAINTEXT');
    expect(await rawDump(A2.dbName)).not.toContain('"$enc"');
  });

  it('a damaged lock record stays locked (wipe is the way out) instead of trusting it', async () => {
    const { A, loop } = await pair();
    await A.svc.lock.enable(PASS);
    await rawDb(A.dbName, (db) => db.lock.update('lock', { 'kdf.iterations': 999_999_999 }));
    const A2 = await reload(A, loop.a);
    expect(A2.svc.lock.state.get()).toBe('locked');
    await expect(A2.svc.lock.unlock(PASS)).rejects.toThrow('wrong-passcode');
    await A2.svc.pairing.wipe();
    expect(A2.svc.lock.state.get()).toBe('disabled');
  });
});

describe('auto-lock', () => {
  function fakeDocument() {
    const subs = new Set<() => void>();
    const doc: VisibilitySource & { set(v: 'visible' | 'hidden'): void } = {
      visibilityState: 'visible',
      addEventListener: (_t, cb) => subs.add(cb),
      removeEventListener: (_t, cb) => subs.delete(cb),
      set(v) {
        (this as { visibilityState: string }).visibilityState = v;
        for (const cb of subs) cb();
      },
    };
    return doc;
  }

  it('locks as soon as the app is hidden when set to "immediately"', async () => {
    const doc = fakeDocument();
    const { A } = await pair({ visibility: doc });
    await A.svc.lock.enable(PASS);
    await A.svc.lock.setAutoLockMinutes(0);
    expect(A.svc.lock.autoLockMinutes.get()).toBe(0);
    doc.set('hidden');
    await A.svc.whenIdle();
    expect(A.svc.lock.state.get()).toBe('locked');
  });

  it('locks on return only after the chosen time; persists the choice; ignores bad values', async () => {
    const doc = fakeDocument();
    let now = 1_700_000_000_000;
    const { A, loop } = await pair({ visibility: doc, now: () => now });
    expect(A.svc.lock.autoLockMinutes.get()).toBe(5);
    await A.svc.lock.enable(PASS);
    await expect(A.svc.lock.setAutoLockMinutes(-1)).rejects.toThrow('invalid-minutes');
    await expect(A.svc.lock.setAutoLockMinutes(1.5)).rejects.toThrow('invalid-minutes');

    doc.set('hidden');
    now += 4 * 60_000;
    doc.set('visible');
    await A.svc.whenIdle();
    expect(A.svc.lock.state.get()).toBe('unlocked');

    doc.set('hidden');
    now += 5 * 60_000;
    doc.set('visible');
    await A.svc.whenIdle();
    expect(A.svc.lock.state.get()).toBe('locked');

    await A.svc.lock.unlock(PASS);
    await A.svc.lock.setAutoLockMinutes(15);
    const A2 = await reload(A, loop.a, { visibility: doc });
    expect(A2.svc.lock.autoLockMinutes.get()).toBe(15);
  });

  it('also locks while still hidden once the time is up (if timers run in the background)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const doc = fakeDocument();
    const loop = createLoopbackPair();
    const A = await openDevice(loop.a, uniqueDbName('bg'), { ...FAST, visibility: doc });
    open.push(A);
    await A.svc.pairing.setDisplayName('Alice');
    await A.svc.lock.enable(PASS);
    await A.svc.lock.setAutoLockMinutes(1);
    doc.set('hidden');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(A.svc.lock.state.get()).toBe('unlocked');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(A.svc.lock.state.get()).toBe('locked');
  });

  it('does nothing without a passcode', async () => {
    const doc = fakeDocument();
    const { A } = await pair({ visibility: doc });
    await A.svc.lock.setAutoLockMinutes(0);
    doc.set('hidden');
    await A.svc.whenIdle();
    expect(A.svc.lock.state.get()).toBe('disabled');
    expect(A.svc.chat.connection.get()).toBe('connected');
  });
});

describe('partner pinning', () => {
  /** A is paired with B; then A comes online on a link where Eve (who has the code) answers. */
  async function impostorSetup() {
    const { A, B, loop, code } = await pair();
    await A.svc.chat.sendText('history-for-bob');
    await settle([A, B]);
    const bobId = B.svc.pairing.profile.get()!.deviceId;
    await B.svc.dispose();
    open.splice(open.indexOf(B), 1);
    loop.unlink();
    await A.svc.chat.sendText('outbox-for-bob');

    const evil = createLoopbackPair();
    const A2 = await reload(A, evil.a);
    const Eve = await openDevice(evil.b, uniqueDbName('eve'), FAST);
    open.push(Eve);
    await Eve.svc.pairing.setDisplayName('Eve');
    await Eve.svc.pairing.acceptPairing(code);
    return { A: A2, Eve, evil, bobId };
  }

  it("ignores hello, msg and meme-want from a device that isn't the paired partner", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { A, Eve, evil, bobId } = await impostorSetup();
    evil.link();
    await settle([A, Eve]);
    expect(A.svc.chat.connection.get()).toBe('connected');

    // Nothing of A's history or outbox reaches Eve, and A still trusts Bob.
    expect(evil.a.sent.filter((f) => f.type === 'msg')).toEqual([]);
    expect(Eve.svc.chat.messages.get()).toEqual([]);
    expect(A.svc.pairing.profile.get()).toMatchObject({ partnerDeviceId: bobId, partnerName: 'Bob' });

    // Eve's messages, wants and renames are dropped.
    await Eve.svc.chat.sendText('i am totally bob');
    evil.b.send({ type: 'meme-want', memeId: 'a'.repeat(64) });
    evil.b.send({ type: 'profile', displayName: 'Bob (new phone)' });
    await settle([A, Eve]);
    expect(texts(A)).toEqual(['history-for-bob', 'outbox-for-bob']);
    expect(evil.a.sent.filter((f) => f.type !== 'hello')).toEqual([]);
    expect(A.svc.pairing.profile.get()!.partnerName).toBe('Bob');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('other than the paired partner'));
  });

  it('a new pairing (createPairing / acceptPairing) resets the pin', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { A, Eve, evil } = await impostorSetup();
    const code = await A.svc.pairing.createPairing();
    expect(A.svc.pairing.profile.get()!.partnerDeviceId).toBeUndefined();
    await Eve.svc.pairing.acceptPairing(code);
    evil.link();
    await settle([A, Eve]);
    // A deliberately paired with this device now, so it is the partner.
    expect(A.svc.pairing.profile.get()!.partnerDeviceId).toBe(Eve.svc.pairing.profile.get()!.deviceId);
    expect(texts(Eve)).toEqual(['history-for-bob', 'outbox-for-bob']);

    await Eve.svc.pairing.acceptPairing(code);
    expect(Eve.svc.pairing.profile.get()!.partnerDeviceId).toBeUndefined();
  });

  it('the real partner reconnecting from a reload is still accepted', async () => {
    const { A, B, loop } = await pair();
    const B2 = await reload(B, loop.b);
    await settle([A, B2]);
    await B2.svc.chat.sendText('same device, new session');
    await settle([A, B2]);
    expect(texts(A)).toContain('same device, new session');
  });
});
