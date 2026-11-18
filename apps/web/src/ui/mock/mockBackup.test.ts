import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setBackupKdfTuning } from '../../db/backupCrypto';
import { createMockServices } from './createMockServices';

let restore: () => void;
beforeAll(() => {
  restore = setBackupKdfTuning({ iterations: 1000, minIterations: 1000 });
});
afterAll(() => restore());

describe('mock backup (demo mode) with a password', () => {
  it('writes the real encrypted format and enforces the same errors', async () => {
    const src = createMockServices({ scenario: 'paired', timeScale: 0 });
    await src.demo.ready;
    const text = src.chat.messages.get().find((m) => m.text)!.text!;
    const blob = await src.backup.exportBackup({ password: 'demo password' });
    const raw = await blob.text();
    expect(JSON.parse(raw)).toMatchObject({ format: 'meme-pals-backup-encrypted', v: 1, kdf: { name: 'PBKDF2' } });
    expect(raw).not.toContain(text);
    await expect(src.backup.exportBackup({ password: '' })).rejects.toThrow('weak-password');

    const s = createMockServices({ scenario: 'onboarded', timeScale: 0 });
    await expect(s.backup.importBackup(blob)).rejects.toThrow('password-required');
    await expect(s.backup.importBackup(blob, { password: 'nope' })).rejects.toThrow('wrong-password');
    const r = await s.backup.importBackup(blob, { password: 'demo password' });
    expect(r.messages).toBe(src.chat.messages.get().length);
    expect(s.chat.messages.get().map((m) => m.text)).toContain(text);
    await Promise.all([src.dispose(), s.dispose()]);
  });
});
