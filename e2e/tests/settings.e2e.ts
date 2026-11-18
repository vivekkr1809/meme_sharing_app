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

async function exportBackup(page: Page): Promise<{ text: string; json: any; filename: string }> {
  await goTab(page, 'Settings');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: T.ui }),
    page.getByRole('button', { name: 'Export backup' }).click(),
  ]);
  const file = await download.path();
  const text = await readFile(file, 'utf8');
  return { text, json: JSON.parse(text), filename: download.suggestedFilename() };
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

async function importBackup(page: Page, text: string) {
  await goTab(page, 'Settings');
  await page.getByTestId('backup-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.getByText(/^Imported \d+ messages? and \d+ memes?$/).waitFor({ timeout: T.ui });
}

describe('settings', () => {
  let a: Device;
  let b: Device;
  let texts: string[];
  let backup: { text: string; json: any; filename: string };
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

  it('backup export → wipe → import brings the history back', async () => {
    const code = (await idbAll(a.page, 'profile'))[0].secret as string;
    backup = await exportBackup(a.page);
    expect(backup.filename).toMatch(/\.json$/);
    expect(backup.json.format).toBe('meme-pals-backup');
    expect(backup.json.messages.map((m: any) => m.text)).toEqual(expect.arrayContaining(texts));
    expect(backup.json.memes.find((m: any) => m.id === post.image.sha256)?.data).toBeTruthy();
    // The pairing secret never goes into a backup file.
    expect(code).toBeTruthy();
    expect(backup.text).not.toContain(code);

    await wipe(a.page);
    for (const s of ['messages', 'memes', 'memeData', 'profile']) expect(await idbAll(a.page, s)).toEqual([]);

    await onboardAndSkipPairing(a.page, a.name);
    await importBackup(a.page, backup.text);
    await goTab(a.page, 'Chat');
    for (const t of texts) await waitBubble(a.page, t);
    const img = a.page.getByRole('list', { name: 'Messages' }).getByRole('img', { name: post.title, exact: true });
    await img.waitFor({ timeout: T.ui });

    // Importing the same file again is a no-op.
    await importBackup(a.page, backup.text);
    await a.page.getByText('Imported 0 messages and 0 memes').waitFor({ timeout: T.ui });
    await goTab(a.page, 'Chat');
    expect((await bubbleTexts(a.page)).filter((x) => texts.includes(x))).toEqual(texts);
  });

  // BUG (see report): after a wipe, Settings → Import is only reachable once the pairing flow has
  // created a NEW pairing secret ("Show my code" → "Continue anyway"). applyBackup() only adopts the
  // backed-up device identity when the local profile has no secret
  // (apps/web/src/db/backup.ts, `!local.secret && ownCount === 0`), so the restored history keeps the
  // OLD deviceId as author and the user's own messages are shown as the partner's.
  // vitest has no test.fixme: it.fails() runs the test and passes only while the bug is present.
  it.fails('[fixme] restored history keeps "mine" attribution after wipe → onboard → import', async () => {
    const mine = bubble(a.page, texts[0]!);
    expect(await mine.getAttribute('class')).toContain('mine');
    expect(await bubble(a.page, texts[1]!).getAttribute('class')).toContain('theirs');
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

    // BUG (see report): after unpairing, "Show my code" never shows the new code. The profile keeps
    // partnerName, so Pairing.tsx:23 (`success = … || !!profile.partnerName`) declares success as soon
    // as createPairing() sets a secret: a false "You're paired! Say hi to <old partner>" screen that
    // auto-advances into the chat, connected to a room nobody else knows. Re-pairing is impossible
    // without a wipe (ShowCode at Pairing.tsx:124 also refuses to show the code once partnerName is set).
    it.fails('[fixme] after unpairing, "Show my code" shows a new code and the two can pair again', async () => {
      await c.page.getByRole('button', { name: /Show my code/ }).click();
      await c.page.locator('.pair-code').waitFor({ timeout: 5_000 });
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
