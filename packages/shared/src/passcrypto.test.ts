import { describe, expect, it } from 'vitest';
import {
  deriveKeyFromPassword,
  exportRawKey,
  generateDataKey,
  importRawKey,
  isKdfParams,
  newKdfParams,
  seal,
  sealString,
  unseal,
  unsealString,
} from './index';

const FAST = 1_000; // tests only

describe('passcrypto', () => {
  it('round-trips with the right password and fails with the wrong one', async () => {
    const params = newKdfParams(FAST);
    const k1 = await deriveKeyFromPassword('correct horse', params);
    const box = await sealString(k1, 'hello', 'ctx');
    expect(await unsealString(await deriveKeyFromPassword('correct horse', params), box, 'ctx')).toBe('hello');
    await expect(unsealString(await deriveKeyFromPassword('wrong', params), box, 'ctx')).rejects.toThrow('decrypt-failed');
    await expect(unsealString(k1, box, 'other-ctx')).rejects.toThrow('decrypt-failed');
    await expect(unsealString(k1, { ...box, ct: box.ct.slice(0, -2) + 'AA' }, 'ctx')).rejects.toThrow('decrypt-failed');
  });

  it('normalizes passwords (NFKC) and uses fresh IVs', async () => {
    const params = newKdfParams(FAST);
    const a = await deriveKeyFromPassword('ｐａｓｓ', params); // full-width
    const box = await sealString(a, 'x');
    expect(await unsealString(await deriveKeyFromPassword('pass', params), box)).toBe('x');
    expect((await sealString(a, 'x')).iv).not.toBe(box.iv);
  });

  it('wraps a data key', async () => {
    const kek = await deriveKeyFromPassword('pin', newKdfParams(FAST));
    const dek = await generateDataKey();
    const wrapped = await seal(kek, await exportRawKey(dek));
    const dek2 = await importRawKey(await unseal(kek, wrapped));
    expect(await unsealString(dek2, await sealString(dek, 'secret'))).toBe('secret');
  });

  it('validates untrusted KDF params', () => {
    expect(isKdfParams(newKdfParams())).toBe(true);
    expect(isKdfParams(newKdfParams(10))).toBe(false); // too weak
    expect(isKdfParams({ ...newKdfParams(), iterations: 1e9 })).toBe(false); // DoS
    expect(isKdfParams({ ...newKdfParams(), salt: 'x' })).toBe(false);
    expect(isKdfParams(newKdfParams(FAST), FAST)).toBe(true);
  });
});
