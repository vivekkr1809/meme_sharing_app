import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bubble,
  bubbleTexts,
  goTab,
  idbAll,
  imgSha256,
  pairedDevices,
  sendText,
  startEnv,
  T,
  token,
  waitBubble,
  waitOnline,
  waitTick,
  type Device,
  type Env,
} from '../support/harness';
import { POSTS } from '../support/upstream';

let env: Env;
let a: Device;
let b: Device;

beforeAll(async () => {
  env = await startEnv();
  [a, b] = await pairedDevices(env);
});
afterAll(async () => {
  await env?.close();
});

describe('persistence', () => {
  it('history, memes and the pairing survive a reload of both phones, and they reconnect on their own', async () => {
    const texts = [token('before-reload-a-'), token('before-reload-b-')];
    await sendText(a.page, texts[0]!);
    await waitBubble(b.page, texts[0]!);
    await sendText(b.page, texts[1]!);
    await waitBubble(a.page, texts[1]!);

    const post = POSTS[2]!;
    await goTab(a.page, 'Discover');
    await a.page.getByRole('button', { name: post.title, exact: true }).click();
    await a.page.getByRole('button', { name: `Send to ${b.name}` }).click();
    const memeOnB = b.page.getByRole('list', { name: 'Messages' }).getByRole('img', { name: post.title, exact: true });
    expect(await imgSha256(b.page, memeOnB)).toBe(post.image.sha256);
    await waitTick(bubble(a.page, texts[0]!), 'Read');

    // Reload both (and fully reopen B: close the page, open a new one in the same profile).
    await a.page.reload();
    await b.page.close();
    await b.reopen();

    for (const d of [a, b]) {
      // Straight into the chat: no onboarding, no pairing screen.
      await d.page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: T.ui });
      expect(await d.page.getByLabel(/What should your partner call you/).count()).toBe(0);
      await waitOnline(d.page);
      const shown = await bubbleTexts(d.page);
      expect(shown).toEqual(expect.arrayContaining(texts));
    }
    await a.page.getByRole('heading', { name: b.name, level: 1 }).waitFor({ timeout: T.ui });
    await b.page.getByRole('heading', { name: a.name, level: 1 }).waitFor({ timeout: T.ui });

    // Read state and the meme bytes survived too.
    await waitTick(bubble(a.page, texts[0]!), 'Read');
    for (const d of [a, b]) {
      const img = d.page.getByRole('list', { name: 'Messages' }).getByRole('img', { name: post.title, exact: true });
      expect(await imgSha256(d.page, img)).toBe(post.image.sha256);
    }
    expect((await idbAll(b.page, 'memes')).map((m) => m.id)).toContain(post.image.sha256);

    // And the link works again.
    const after = token('after-reload-');
    await sendText(b.page, after);
    await waitBubble(a.page, after);
    // No duplicates were created by the re-sync.
    const onA = await bubbleTexts(a.page);
    for (const t of [...texts, after]) expect(onA.filter((x) => x === t)).toHaveLength(1);
  });
});
