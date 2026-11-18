import { encodePairingCode, generatePairingSecret } from '../../packages/shared/src/index';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bubbleTexts, goTab, onboard, pair, sendText, startEnv, T, token, waitBubble, type Env } from '../support/harness';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.close();
});

describe('pairing', () => {
  it('happy path: both sides learn each other’s name in the chat header', async () => {
    const [nameA, nameB] = [token('Ava'), token('Ben')];
    const [a, b] = await Promise.all([env.newDevice(nameA), env.newDevice(nameB)]);
    await Promise.all([onboard(a.page, nameA), onboard(b.page, nameB)]);
    const code = await pair(a, b);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);

    await a.page.getByRole('heading', { name: nameB, level: 1 }).waitFor({ timeout: T.ui });
    await b.page.getByRole('heading', { name: nameA, level: 1 }).waitFor({ timeout: T.ui });

    // Settings agrees.
    await goTab(a.page, 'Settings');
    await a.page.getByText(`Paired with ${nameB}`).waitFor({ timeout: T.ui });
  });

  it('rejects an invalid code with a friendly error', async () => {
    const d = await env.newDevice(token('Cal'));
    await onboard(d.page, d.name);
    await d.page.getByRole('button', { name: /Join my partner/ }).click();
    await d.page.getByLabel('Pairing code').fill('NOT-A-REAL-CODE');
    await d.page.getByRole('button', { name: 'Join', exact: true }).click();
    const alert = d.page.getByRole('alert');
    await alert.waitFor({ timeout: T.ui });
    expect(await alert.textContent()).toMatch(/doesn't look right/);
    // Still on the join form, not paired.
    expect(await d.page.getByLabel('Pairing code').isVisible()).toBe(true);

    // A truncated code, and one with a character outside Crockford base32 ('U'), are rejected too.
    // (Note: the code has no checksum, so a single mistyped *valid* character is NOT caught; see report.)
    const good = encodePairingCode(generatePairingSecret());
    for (const bad of [good.slice(0, -5), good.slice(0, -1) + 'U']) {
      await d.page.getByLabel('Pairing code').fill(bad);
      await d.page.getByRole('button', { name: 'Join', exact: true }).click();
      await d.page.getByRole('alert').filter({ hasText: /doesn't look right/ }).waitFor({ timeout: T.ui });
      expect(await d.page.getByText('Waiting for your partner…').count()).toBe(0);
    }
  });

  it('a third device with a different code (or the same code) cannot see the conversation', async () => {
    const [a, b] = await Promise.all([env.newDevice(token('Ava')), env.newDevice(token('Ben'))]);
    await Promise.all([onboard(a.page, a.name), onboard(b.page, b.name)]);
    const code = await pair(a, b);

    // C joins a different (valid) room.
    const c = await env.newDevice(token('Eve'));
    await onboard(c.page, c.name);
    await c.page.getByRole('button', { name: /Join my partner/ }).click();
    await c.page.getByLabel('Pairing code').fill(encodePairingCode(generatePairingSecret()));
    await c.page.getByRole('button', { name: 'Join', exact: true }).click();
    await c.page.getByText('Waiting for your partner…').waitFor({ timeout: T.sync });

    // D tries the real code while both partners are in the room: the relay refuses a third peer.
    const d = await env.newDevice(token('Mal'));
    await onboard(d.page, d.name);
    await d.page.getByRole('button', { name: /Join my partner/ }).click();
    await d.page.getByLabel('Pairing code').fill(code);
    await d.page.getByRole('button', { name: 'Join', exact: true }).click();

    const secret = token('secret-msg-');
    await sendText(a.page, secret);
    await waitBubble(b.page, secret);

    for (const x of [c, d]) {
      await x.page.getByRole('button', { name: 'Continue anyway' }).click();
      await x.page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: T.ui });
      // The header never learns a partner name, and no messages arrive.
      await x.page.getByRole('heading', { name: 'Say hi to your partner' }).waitFor({ timeout: T.ui });
      expect(await bubbleTexts(x.page)).toEqual([]);
      expect(await x.page.getByText(secret).count()).toBe(0);
      expect(await x.page.locator('.chat-top .topbar-title').textContent()).toBe('Your partner');
    }
    // And A/B never learned about C or D.
    expect(await a.page.locator('.chat-top .topbar-title').textContent()).toBe(b.name);
    expect(await b.page.locator('.chat-top .topbar-title').textContent()).toBe(a.name);
  });
});
