import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  deriveKeyFromPassword,
  newKdfParams,
  seal,
  toBase64Url,
  unseal,
  type PasswordKdfParams,
} from '@memes/shared';
import { createLoopbackPair } from '../testing/loopback';
import { openDevice, pairedDevices, randomImage, rawDb, settle, uniqueDbName, type Device } from '../sync/testkit';
import { BACKUP_FORMAT } from './backup';
import {
  BACKUP_AAD,
  ENCRYPTED_BACKUP_FORMAT,
  MAX_BACKUP_FILE_BYTES,
  bytesToBase64Url,
  encryptBackup,
  isEncryptedBackupFile,
  openBackupFile,
  setBackupKdfTuning,
} from './backupCrypto';

/** Cheap PBKDF2 for tests; the real default (600k) is checked once below. */
const ITER = 1000;
let restoreTuning: () => void;
beforeAll(() => {
  restoreTuning = setBackupKdfTuning({ iterations: ITER, minIterations: ITER });
});
afterAll(() => restoreTuning());

const open: Device[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((d) => d.svc.dispose()));
});

const PW = 'correct horse battery staple';
const enc = new TextEncoder();
const blob = (text: string) => new Blob([text], { type: 'application/json' });
const pngBlob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'resolved';
}

async function freshDevice(tag: string): Promise<Device> {
  const d = await openDevice(createLoopbackPair().a, uniqueDbName(tag));
  open.push(d);
  await d.svc.pairing.setDisplayName('New phone');
  return d;
}

/** A paired device with chat history, a meme (bytes known) and custom subreddits. */
async function populated() {
  const { A, B, code: pairingCode } = await pairedDevices();
  open.push(A, B);
  const bytes = randomImage(6000, 42);
  const meme = await A.svc.library.importImage({ blob: pngBlob(bytes), mime: 'image/png', width: 4, height: 4, source: 'upload', title: 'Grumpy cat' });
  await A.svc.chat.sendText('secret plans for saturday');
  await A.svc.chat.sendMeme(meme.id, 'caption about the meme');
  await B.svc.chat.sendText('reply from bob 🎉');
  await A.svc.settings.update({ subreddits: ['catsstandingup', 'okbuddyretard'] });
  await settle([A, B]);
  return { A, B, bytes, meme, pairingCode };
}

describe('encrypted backup file format', () => {
  it('round-trips with the right password and has the documented shape', async () => {
    const plain = JSON.stringify({ format: BACKUP_FORMAT, hello: 'wörld 🎉', n: 1 });
    const file = await encryptBackup(plain, PW);
    expect(file.type).toBe('application/json');
    const json = JSON.parse(await file.text());
    expect(Object.keys(json)).toEqual(['format', 'v', 'kdf', 'box']);
    expect(json).toMatchObject({ format: ENCRYPTED_BACKUP_FORMAT, v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER } });
    expect(json.kdf.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(json.box.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await isEncryptedBackupFile(file)).toBe(true);
    expect(await openBackupFile(file, PW)).toEqual(JSON.parse(plain));
  });

  it('uses a fresh salt and IV for every export', async () => {
    const a = JSON.parse(await (await encryptBackup('{}', PW)).text());
    const b = JSON.parse(await (await encryptBackup('{}', PW)).text());
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.box.iv).not.toBe(b.box.iv);
    expect(a.box.ct).not.toBe(b.box.ct);
  });

  it('defaults to PBKDF2_ITERATIONS', async () => {
    const restore = setBackupKdfTuning({ iterations: PBKDF2_ITERATIONS });
    try {
      const json = JSON.parse(await (await encryptBackup('{}', PW)).text());
      expect(json.kdf.iterations).toBe(PBKDF2_ITERATIONS);
    } finally {
      restore();
    }
  });

  it('is byte-compatible with seal/unseal from @memes/shared', async () => {
    const plain = '{"format":"meme-pals-backup","x":"interop"}';
    const json = JSON.parse(await (await encryptBackup(plain, PW)).text());
    const key = await deriveKeyFromPassword(PW, json.kdf as PasswordKdfParams);
    expect(new TextDecoder().decode(await unseal(key, json.box, enc.encode(BACKUP_AAD)))).toBe(plain);

    const kdf = newKdfParams(ITER);
    const box = await seal(await deriveKeyFromPassword(PW, kdf), enc.encode(plain), enc.encode(BACKUP_AAD));
    const other = blob(JSON.stringify({ format: ENCRYPTED_BACKUP_FORMAT, v: 1, kdf, box }));
    expect(await openBackupFile(other, PW)).toEqual(JSON.parse(plain));
  });

  it('wrong password → wrong-password; missing password → password-required', async () => {
    const file = await encryptBackup('{}', PW);
    expect(await code(openBackupFile(file, 'correct horse battery stapl'))).toBe('wrong-password');
    expect(await code(openBackupFile(file))).toBe('password-required');
    expect(await code(openBackupFile(file, ''))).toBe('password-required');
    // Also for a re-formatted (pretty-printed) file, which takes the general parsing path.
    const pretty = blob(JSON.stringify(JSON.parse(await file.text()), null, 2));
    expect(await code(openBackupFile(pretty))).toBe('password-required');
    expect(await code(openBackupFile(pretty, 'nope nope'))).toBe('wrong-password');
    expect(await openBackupFile(pretty, PW)).toEqual({});
  });

  it('passwords are NFKC-normalized (same passphrase typed on different keyboards)', async () => {
    const file = await encryptBackup('{}', 'café au lait');
    expect(await openBackupFile(file, 'café au lait')).toEqual({});
  });

  it('detects tampering with the ciphertext, IV, salt or iterations', async () => {
    const json = JSON.parse(await (await encryptBackup(JSON.stringify({ msg: 'x'.repeat(200) }), PW)).text());
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    const variants = [
      { ...json, box: { ...json.box, ct: flip(json.box.ct, 40) } },
      { ...json, box: { ...json.box, ct: flip(json.box.ct, json.box.ct.length - 3) } }, // auth tag
      { ...json, box: { ...json.box, iv: flip(json.box.iv, 3) } },
      { ...json, kdf: { ...json.kdf, salt: flip(json.kdf.salt, 5) } },
      { ...json, kdf: { ...json.kdf, iterations: ITER + 1 } },
    ];
    for (const v of variants) expect(await code(openBackupFile(blob(JSON.stringify(v)), PW))).toBe('wrong-password');
  });

  it('rejects absurd or weak KDF parameters without running them', async () => {
    const json = JSON.parse(await (await encryptBackup('{}', PW)).text());
    for (const iterations of [PBKDF2_MAX_ITERATIONS + 1, 1e12, ITER - 1, 0, -5, 1.5, '1000']) {
      const t = Date.now();
      expect(await code(openBackupFile(blob(JSON.stringify({ ...json, kdf: { ...json.kdf, iterations } })), PW))).toBe('invalid-backup');
      expect(Date.now() - t).toBeLessThan(500);
    }
    // Without the test tuning, anything below PBKDF2_MIN_ITERATIONS is refused.
    expect(await code(openBackupFile(blob(JSON.stringify(json)), PW, { minIterations: 100_000 }))).toBe('invalid-backup');
    const bad = [
      { ...json, kdf: { ...json.kdf, name: 'scrypt' } },
      { ...json, kdf: { ...json.kdf, hash: 'SHA-1' } },
      { ...json, kdf: { ...json.kdf, salt: 'short' } },
      { ...json, kdf: undefined },
      { ...json, box: { ...json.box, iv: 'AAAA' } },
      { ...json, box: { ...json.box, ct: 'not base64!' } },
      { ...json, box: { ...json.box, ct: 'AAAAA' } },
      { ...json, box: null },
      { ...json, v: 2 },
    ];
    for (const v of bad) expect(await code(openBackupFile(blob(JSON.stringify(v)), PW))).toBe('invalid-backup');
  });

  it('rejects junk and oversized files as invalid-backup', async () => {
    expect(await code(openBackupFile(blob('not json'), PW))).toBe('invalid-backup');
    expect(await code(openBackupFile(blob(''), PW))).toBe('invalid-backup');
    const json = await (await encryptBackup('{}', PW)).text();
    expect(await code(openBackupFile(blob(json.slice(0, -1)), PW))).toBe('invalid-backup');
    // Ciphertext with characters outside base64url, in the canonical layout.
    expect(await code(openBackupFile(blob(json.replace('"ct":"', '"ct":"%%')), PW))).toBe('invalid-backup');
    // The size is checked before anything is read.
    const huge = { size: MAX_BACKUP_FILE_BYTES + 1, slice: () => { throw new Error('read'); }, text: () => { throw new Error('read'); } };
    expect(await code(openBackupFile(huge as unknown as Blob, PW))).toBe('invalid-backup');
  });

  it('handles ciphertexts larger than one decode chunk', async () => {
    const big = JSON.stringify({ data: bytesToBase64Url(randomImage(4 * 1024 * 1024, 7)) });
    const file = await encryptBackup(big, PW);
    expect(file.size).toBeGreaterThan(5 * 1024 * 1024);
    expect(await openBackupFile(file, PW)).toEqual(JSON.parse(big));
  });

  it('base64url encoder matches @memes/shared', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 1000, 3 * 256 * 1024 - 1, 3 * 256 * 1024, 3 * 256 * 1024 + 2]) {
      const b = randomImage(n, n + 1);
      expect(bytesToBase64Url(b)).toBe(toBase64Url(b));
    }
  });

  it('refuses to encrypt with an empty password', async () => {
    expect(await code(encryptBackup('{}', ''))).toBe('weak-password');
  });
});

describe('BackupService with passwords', () => {
  it('export with a password → import on a fresh phone restores everything, "mine" intact', async () => {
    const { A } = await populated();
    const file = await A.svc.backup.exportBackup({ password: PW });
    expect(await isEncryptedBackupFile(file)).toBe(true);

    const C = await freshDevice('restore');
    expect(await code(C.svc.backup.importBackup(file))).toBe('password-required');
    expect(await code(C.svc.backup.importBackup(file, { password: 'wrong password' }))).toBe('wrong-password');
    expect(C.svc.chat.messages.get()).toHaveLength(0);
    expect(await C.svc.backup.importBackup(file, { password: PW })).toEqual({ messages: 3, memes: 1 });
    const view = (d: Device) => d.svc.chat.messages.get().map((m) => [m.text, m.mine, m.authorId]);
    expect(view(C)).toEqual(view(A));
    expect(C.svc.chat.messages.get().filter((m) => m.mine).map((m) => m.text)).toEqual(['secret plans for saturday', 'caption about the meme']);
    expect(C.svc.pairing.profile.get()).toMatchObject({ deviceId: A.svc.pairing.profile.get()!.deviceId, partnerName: 'Bob', paired: false });
    expect(C.svc.settings.settings.get().subreddits).toEqual(['catsstandingup', 'okbuddyretard']);
    // Idempotent.
    expect(await C.svc.backup.importBackup(file, { password: PW })).toEqual({ messages: 0, memes: 0 });
  });

  it('the encrypted file contains no known plaintext and never the pairing secret', async () => {
    const { A, bytes, meme, pairingCode } = await populated();
    const secret = await rawDb(A.dbName, async (db) => (await db.profile.get('me'))!.secret!);
    const text = await (await A.svc.backup.exportBackup({ password: PW })).text();
    const b64 = bytesToBase64Url(bytes);
    const deviceId = A.svc.pairing.profile.get()!.deviceId;
    for (const needle of [
      'secret plans',
      'saturday',
      'caption about',
      'reply from bob',
      // Short names could appear in random base64 by chance; quoted, they can't (no quotes in base64).
      '"Alice"',
      '"Bob"',
      'Alice',
      'Grumpy',
      'catsstandingup',
      'okbuddyretard',
      'subreddits',
      'messages',
      deviceId,
      meme.id,
      b64.slice(0, 64),
      b64.slice(3000, 3064),
      btoa(String.fromCharCode(...bytes.subarray(0, 48))),
      secret,
      pairingCode,
      pairingCode.replace(/-/g, ''),
    ]) {
      expect(text, needle).not.toContain(needle);
    }
    // The decrypted plaintext (exactly the plain backup JSON) has no secret either.
    const plain = JSON.stringify(await openBackupFile(new Blob([text]), PW));
    expect(plain).toContain('secret plans for saturday');
    expect(plain).not.toContain(secret);
    expect(plain).not.toMatch(/"secret"/);
  });

  it('the plaintext is exactly the plain backup', async () => {
    const { A } = await populated();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const plain = await (await A.svc.backup.exportBackup()).text();
    const decrypted = await openBackupFile(await A.svc.backup.exportBackup({ password: PW }), PW);
    spy.mockRestore();
    expect(JSON.stringify(decrypted)).toBe(plain);
  });

  it('legacy plain backups still import, with or without a password', async () => {
    const { A } = await populated();
    const file = await A.svc.backup.exportBackup();
    expect(JSON.parse(await file.text()).format).toBe(BACKUP_FORMAT);
    expect(await isEncryptedBackupFile(file)).toBe(false);
    const C = await freshDevice('legacy');
    expect(await C.svc.backup.importBackup(file)).toEqual({ messages: 3, memes: 1 });
    const D = await freshDevice('legacy2');
    expect(await D.svc.backup.importBackup(file, { password: 'ignored' })).toEqual({ messages: 3, memes: 1 });
  });

  it('export rejects an empty password instead of silently writing a plain file', async () => {
    const { A } = await populated();
    expect(await code(A.svc.backup.exportBackup({ password: '' }))).toBe('weak-password');
  });

  it('rejects a backup whose decrypted content is not a backup', async () => {
    const C = await freshDevice('junk');
    expect(await code(C.svc.backup.importBackup(await encryptBackup('{"format":"nope"}', PW), { password: PW }))).toBe('invalid-backup');
    expect(await code(C.svc.backup.importBackup(await encryptBackup('not json', PW), { password: PW }))).toBe('invalid-backup');
  });
});
