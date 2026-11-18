/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bubble,
  bubbleTexts,
  goTab,
  idbAll,
  onboard,
  pair,
  pairedDevices,
  sendText,
  startEnv,
  T,
  token,
  waitBubble,
  waitOnline,
  type Device,
  type Env,
  type Page,
} from '../support/harness';
import { POSTS } from '../support/upstream';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.close();
});

const PASSWORD = 'tacos on tuesday 42';

async function exportBackup(page: Page, password = PASSWORD): Promise<{ text: string; json: any; filename: string }> {
  await goTab(page, 'Settings');
  await page.getByRole('button', { name: 'Export backup' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export an encrypted backup' });
  await dialog.getByText("If you forget this password, the backup can't be opened. We can't recover it.").waitFor({ timeout: T.ui });
  await dialog.getByLabel('Backup password').fill(password);
  await dialog.getByLabel('Confirm password').fill(password);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: T.ui }),
    dialog.getByRole('button', { name: /Encrypt & download/ }).click(),
  ]);
  const file = await download.path();
  const text = await readFile(file, 'utf8');
  await dialog.waitFor({ state: 'detached', timeout: T.ui });
  return { text, json: JSON.parse(text), filename: download.suggestedFilename() };
}

/** Decrypt an encrypted backup independently of the app (Node WebCrypto): PBKDF2-SHA256 → AES-GCM. */
async function decryptBackup(json: any, password: string): Promise<string> {
  const { subtle } = globalThis.crypto;
  const b64 = (s: string) => Buffer.from(s, 'base64url');
  const base = await subtle.importKey('raw', Buffer.from(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: json.kdf.iterations, salt: b64(json.kdf.salt) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(json.box.iv), additionalData: Buffer.from('meme-pals-backup-v1') }, key, b64(json.box.ct));
  return Buffer.from(pt).toString('utf8');
}

async function wipe(page: Page) {
  await goTab(page, 'Settings');
  await page.getByRole('button', { name: 'Wipe all data' }).click();
  await page.getByRole('alertdialog', { name: 'Wipe all data?' }).getByRole('button', { name: 'Wipe everything' }).click();
  await page.getByLabel(/What should your partner call you/).waitFor({ timeout: T.ui });
}

/** After a wipe the only way into Settings is through the pairing flow ("Continue anyway"). */
async function onboardAndSkipPairing(page: Page, name: string) {
  await onboard(page, name);
  await page.getByRole('button', { name: /Show my code/ }).click();
  await page.getByRole('button', { name: 'Continue anyway' }).click();
  await page.getByRole('navigation', { name: 'Main' }).waitFor({ timeout: T.ui });
}

function pickBackup(page: Page, text: string) {
  return page.getByTestId('backup-file').setInputFiles({ name: 'meme-pals-backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
}

const importedToast = (page: Page) => page.getByText(/^Imported \d+ messages? and \d+ memes?$/);

/** Import a plain (legacy) backup: no password prompt. */
async function importPlainBackup(page: Page, text: string) {
  await goTab(page, 'Settings');
  await pickBackup(page, text);
  await importedToast(page).waitFor({ timeout: T.ui });
  expect(await page.getByRole('dialog').count()).toBe(0);
}

/** Import an encrypted backup through the password prompt. */
async function importEncryptedBackup(page: Page, text: string, password = PASSWORD) {
  await goTab(page, 'Settings');
  await pickBackup(page, text);
  const dialog = page.getByRole('dialog', { name: 'Enter the backup password' });
  await dialog.getByLabel('Backup password').fill(password);
  await dialog.getByRole('button', { name: /Unlock & import/ }).click();
  await importedToast(page).waitFor({ timeout: T.ui });
  await dialog.waitFor({ state: 'detached', timeout: T.ui });
}

describe('settings', () => {
  let a: Device;
  let b: Device;
  let texts: string[];
  let backup: { text: string; json: any; filename: string };
  let plainBackup: string;
  const post = POSTS[0]!;

  beforeAll(async () => {
    [a, b] = await pairedDevices(env);
    texts = [token('keep-me-a-'), token('keep-me-b-')];
    await sendText(a.page, texts[0]!);
    await waitBubble(b.page, texts[0]!);
    await sendText(b.page, texts[1]!);
    await waitBubble(a.page, texts[1]!);
    await goTab(b.page, 'Discover');
    await b.page.getByRole('button', { name: post.title, exact: true }).click();
    await b.page.getByRole('button', { name: `Send to ${a.name}` }).click();
    await a.page.getByRole('list', { name: 'Messages' }).getByRole('img', { name: post.title, exact: true }).waitFor({ timeout: T.sync });
  });

  it('encrypted backup export → wipe → import (with password) brings the history back', async () => {
    const code = (await idbAll(a.page, 'profile'))[0].secret as string;
    const deviceId = (await idbAll(a.page, 'profile'))[0].deviceId as string;
    backup = await exportBackup(a.page);
    expect(backup.filename).toMatch(/^meme-pals-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(backup.json).toMatchObject({ format: 'meme-pals-backup-encrypted', v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 } });
    expect(Object.keys(backup.json)).toEqual(['format', 'v', 'kdf', 'box']);

    // No known plaintext in the file: messages, names, meme bytes, subreddits, ids, pairing secret.
    const memeB64 = post.image.bytes.toString('base64url');
    const subs = (await idbAll(a.page, 'settings'))[0]?.value?.subreddits ?? ['wholesomememes', 'ProgrammerHumor'];
    for (const needle of [
      ...texts,
      a.name,
      b.name,
      post.title,
      post.image.sha256,
      memeB64.slice(0, 64),
      memeB64.slice(-64),
      post.image.bytes.toString('base64').slice(8, 72),
      ...subs.filter((x: string) => x.length > 6),
      'subreddits',
      deviceId,
      code,
    ]) {
      expect(backup.text, needle).not.toContain(needle);
    }

    // Independently decrypted, the plaintext is the plain backup (still without the pairing secret).
    const plain = await decryptBackup(backup.json, PASSWORD);
    plainBackup = plain;
    const pj = JSON.parse(plain);
    expect(pj.format).toBe('meme-pals-backup');
    expect(pj.messages.map((m: any) => m.text)).toEqual(expect.arrayContaining(texts));
    expect(pj.memes.find((m: any) => m.id === post.image.sha256)?.data).toBe(memeB64);
    expect(plain).not.toContain(code);

    await wipe(a.page);
    for (const s of ['messages', 'memes', 'memeData', 'profile']) expect(await idbAll(a.page, s)).toEqual([]);

    await onboardAndSkipPairing(a.page, a.name);
    await goTab(a.page, 'Settings');
    await pickBackup(a.page, backup.text);
    const dialog = a.page.getByRole('dialog', { name: 'Enter the backup password' });
    await dialog.waitFor({ timeout: T.ui });
    await dialog.getByText('meme-pals-backup.json').waitFor({ timeout: T.ui });

    // Wrong password: inline error, nothing imported, and the user can retry without re-picking the file.
    await dialog.getByLabel('Backup password').fill('not the password');
    await dialog.getByRole('button', { name: /Unlock & import/ }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Wrong password. Check it and try again.' }).waitFor({ timeout: T.ui });
    expect(await idbAll(a.page, 'messages')).toEqual([]);
    await dialog.getByLabel('Backup password').fill(PASSWORD);
    await dialog.getByRole('button', { name: /Unlock & import/ }).click();
    await importedToast(a.page).waitFor({ timeout: T.ui });
    await dialog.waitFor({ state: 'detached', timeout: T.ui });
    await a.page.getByText(/^Last import: \d+ messages? and \d+ memes? from meme-pals-backup\.json\.$/).waitFor({ timeout: T.ui });

    await goTab(a.page, 'Chat');
    for (const t of texts) await waitBubble(a.page, t);
    const img = a.page.getByRole('list', { name: 'Messages' }).getByRole('img', { name: post.title, exact: true });
    await img.waitFor({ timeout: T.ui });

    // Importing the same file again is a no-op.
    await importEncryptedBackup(a.page, backup.text);
    await a.page.getByText('Imported 0 messages and 0 memes').waitFor({ timeout: T.ui });
    await goTab(a.page, 'Chat');
    expect((await bubbleTexts(a.page)).filter((x) => texts.includes(x))).toEqual(texts);
  });

  // Regression: after a wipe, Settings → Import is only reachable once the pairing flow has created a
  // NEW pairing secret. applyBackup() must still adopt the backed-up identity (it now does whenever the
  // device has no messages of its own), or the user's own messages would show as the partner's.
  it('restored history keeps "mine" attribution after wipe → onboard → import', async () => {
    const mine = bubble(a.page, texts[0]!);
    expect(await mine.getAttribute('class')).toContain('mine');
    expect(await bubble(a.page, texts[1]!).getAttribute('class')).toContain('theirs');
  });

  it('legacy plain backups still import, without a password prompt', async () => {
    const c = await env.newDevice(token('Cat'));
    await onboardAndSkipPairing(c.page, c.name);
    await importPlainBackup(c.page, plainBackup);
    await c.page.getByText(/^Imported [1-9]\d* messages? and 1 meme$/).waitFor({ timeout: T.ui });
    await goTab(c.page, 'Chat');
    for (const t of texts) await waitBubble(c.page, t);
    expect(await bubble(c.page, texts[0]!).getAttribute('class')).toContain('mine');
    expect(await bubble(c.page, texts[1]!).getAttribute('class')).toContain('theirs');
    await c.context.close();
  });

  describe('unpair', () => {
    let c: Device;
    let d: Device;
    const t = token('before-unpair-');

    it('goes back to the pairing screen, keeps history, and the partner sees us offline', async () => {
      [c, d] = await pairedDevices(env);
      await sendText(c.page, t);
      await waitBubble(d.page, t);

      const joinedBefore = env.relay.stats().joined;
      await goTab(c.page, 'Settings');
      await c.page.getByRole('button', { name: 'Unpair', exact: true }).click();
      await c.page.getByRole('alertdialog', { name: `Unpair from ${d.name}?` }).getByRole('button', { name: 'Unpair' }).click();
      await c.page.getByRole('heading', { name: 'Pair with your partner' }).waitFor({ timeout: T.ui });
      expect((await idbAll(c.page, 'profile'))[0].secret).toBeUndefined();
      expect((await idbAll(c.page, 'messages')).some((m: any) => m.text === t)).toBe(true);
      await d.page.locator('.chat-top .topbar-sub', { hasText: /^offline$/ }).waitFor({ timeout: T.sync });
      expect(env.relay.stats().joined).toBe(joinedBefore - 1); // C left the relay room; D still waits

      // Survives a reload: still unpaired, no connection attempt.
      await c.page.reload();
      await c.page.getByRole('heading', { name: 'Pair with your partner' }).waitFor({ timeout: T.ui });
      expect(env.relay.stats().joined).toBe(joinedBefore - 1);
    });

    // Regression: unpair keeps partnerName, which used to make "Show my code" declare a false
    // "You're paired!" immediately. Success now requires a live connection or a new partner device.
    it('after unpairing, "Show my code" shows a new code and the two can pair again', async () => {
      await c.page.getByRole('button', { name: /Show my code/ }).click();
      await c.page.locator('.pair-code').waitFor({ timeout: 5_000 });
      await c.page.getByRole('button', { name: /Back/ }).click();
      await goTab(d.page, 'Settings');
      await d.page.getByRole('button', { name: 'Unpair', exact: true }).click();
      await d.page.getByRole('alertdialog').getByRole('button', { name: 'Unpair' }).click();
      await pair(c, d);
      await waitBubble(c.page, t);
      const again = token('after-repair-');
      await sendText(d.page, again);
      await waitBubble(c.page, again);
      await waitOnline(c.page);
    });
  });
});
