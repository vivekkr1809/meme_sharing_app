/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../support/images';
import { goTab, idbAll, imgSha256, pairedDevices, startEnv, T, type Device, type Env, type Page } from '../support/harness';
import { POSTS, relayUpstreamLog, TEMPLATES } from '../support/upstream';

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

/** The displayed meme image in the chat with this accessible name (not the "receiving…" placeholder). */
const chatMeme = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Messages' }).getByRole('img', { name, exact: true }).last();

async function sendFromDiscover(d: Device, partner: Device, title: string) {
  await goTab(d.page, 'Discover');
  const tile = d.page.getByRole('button', { name: title, exact: true });
  await tile.waitFor({ timeout: T.sync });
  await tile.click();
  const sheet = d.page.getByRole('dialog', { name: title });
  await sheet.getByRole('button', { name: `Send to ${partner.name}` }).click();
  // Sending switches back to the chat.
  await d.page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: T.sync });
}

/** Both sides display the same bytes, and those bytes are the content id (sha256). */
async function expectSameMeme(name: string, expectedSha?: string): Promise<string> {
  const [shaA, shaB] = await Promise.all([imgSha256(a.page, chatMeme(a.page, name)), imgSha256(b.page, chatMeme(b.page, name))]);
  expect(shaB).toBe(shaA);
  if (expectedSha) expect(shaA).toBe(expectedSha);
  const memesB = await idbAll(b.page, 'memes');
  const row = memesB.find((m: any) => m.id === shaB);
  expect(row, 'B stores the meme under its sha256').toBeTruthy();
  expect(row.has).toBe(1);
  const dataB = await idbAll(b.page, 'memeData');
  expect(dataB.some((m: any) => m.id === shaB)).toBe(true);
  return shaA;
}

describe('memes', () => {
  it('Discover (direct route): the mocked Reddit feed renders, NSFW is hidden, and "Send to partner" delivers identical bytes', async () => {
    relayUpstreamLog.length = 0;
    await goTab(a.page, 'Discover');
    for (const p of POSTS.filter((p) => !p.nsfw)) {
      await a.page.getByRole('button', { name: p.title, exact: true }).waitFor({ timeout: T.sync });
    }
    expect(await a.page.getByRole('button', { name: POSTS.find((p) => p.nsfw)!.title }).count()).toBe(0);

    const post = POSTS[0]!;
    await sendFromDiscover(a, b, post.title);
    await expectSameMeme(post.title, post.image.sha256);

    // Everything came straight from the (mocked) hosts; the relay proxy was never asked.
    expect(a.directHits.some((u) => u.startsWith('https://www.reddit.com/r/memes/hot.json'))).toBe(true);
    expect(a.directHits).toContain(post.image.url);
    expect(relayUpstreamLog.filter((u) => /reddit\.com|i\.redd\.it/.test(u))).toEqual([]);
  });

  it('Discover (direct route blocked): falls back to the relay proxy and still delivers identical bytes', async () => {
    a.memeRoute = 'blocked';
    relayUpstreamLog.length = 0;
    const directBefore = a.directHits.length;
    await a.page.reload(); // forget the remembered route
    await a.page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: T.ui });
    const post = POSTS[1]!;
    await sendFromDiscover(a, b, post.title);
    await expectSameMeme(post.title, post.image.sha256);

    expect(relayUpstreamLog.some((u) => u.startsWith('https://www.reddit.com/r/memes/hot.json'))).toBe(true);
    expect(relayUpstreamLog).toContain(post.image.url);
    expect(a.directHits.length).toBe(directBefore);
    a.memeRoute = 'direct';
  });

  it('Upload: a generated JPEG attached in the composer reaches B', async () => {
    await goTab(a.page, 'Chat');
    const jpeg: number[] = await a.page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 480;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 640, 480);
      grad.addColorStop(0, '#ff0066');
      grad.addColorStop(1, '#00ccff');
      g.fillStyle = grad;
      g.fillRect(0, 0, 640, 480);
      g.fillStyle = '#fff';
      g.font = 'bold 64px sans-serif';
      g.fillText('E2E UPLOAD', 120, 260);
      const blob: Blob = await new Promise((r) => c.toBlob((x) => r(x!), 'image/jpeg', 0.9));
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    const buf = Buffer.from(jpeg);
    expect(buf.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    await a.page.locator('form.composer input[type=file]').setInputFiles({ name: 'e2e-upload.jpg', mimeType: 'image/jpeg', buffer: buf });
    const sha = await expectSameMeme('e2e-upload');
    // The upload is re-encoded on-device (metadata stripped), so it is not the original file.
    expect(sha).not.toBe(sha256Hex(buf));
    const row = (await idbAll(b.page, 'memes')).find((m: any) => m.id === sha);
    expect(row.source).toBe('upload');
    expect(row.width).toBe(640);
  });

  it('Meme maker: pick a mocked template, caption it, send; B receives it', async () => {
    const tpl = TEMPLATES[0]!;
    await goTab(a.page, 'Make');
    const list = a.page.getByRole('list', { name: 'Templates' });
    await list.getByRole('button', { name: tpl.name }).click();
    await a.page.getByLabel('Top text').fill('writing e2e tests');
    await a.page.getByLabel('Bottom text').fill('watching them pass');
    await a.page.getByRole('img', { name: 'Preview: writing e2e tests / watching them pass' }).waitFor({ timeout: T.sync });
    await a.page.getByRole('button', { name: `Send to ${b.name}` }).click();
    await a.page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: T.sync });
    const sha = await expectSameMeme('writing e2e tests / watching them pass');
    expect(sha).not.toBe(tpl.image.sha256); // captions were drawn into the pixels
    const row = (await idbAll(b.page, 'memes')).find((m: any) => m.id === sha);
    expect(row.source).toBe('maker');
  });

  it('Gallery: favorite a meme, then filter by favorites and by title', async () => {
    await goTab(b.page, 'Gallery');
    const all = b.page.getByRole('list', { name: 'All memes' });
    await all.waitFor({ timeout: T.ui });
    await b.page.waitForFunction(() => document.querySelectorAll('ul[aria-label="All memes"] > li').length === 4, null, { timeout: T.ui });

    const fav = POSTS[1]!.title;
    await all.getByRole('button', { name: fav, exact: true }).click();
    const viewer = b.page.getByRole('dialog', { name: fav });
    await viewer.getByRole('button', { name: 'Favorite', exact: true }).click();
    await viewer.getByRole('button', { name: 'Favorited' }).waitFor({ timeout: T.ui });
    await viewer.getByRole('button', { name: 'Close' }).click();

    await b.page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: '★ Favorites' }).check();
    const favs = b.page.getByRole('list', { name: 'Favorite memes' });
    await favs.waitFor({ timeout: T.ui });
    await b.page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Favorite memes"] > li').length === 1, null, { timeout: T.ui });
    expect(await favs.getByRole('button', { name: fav, exact: true }).count()).toBe(1);

    await b.page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: 'All' }).check();
    await b.page.getByRole('searchbox', { name: 'Search memes' }).fill('webrtc');
    await b.page.waitForFunction(() => document.querySelectorAll('ul[aria-label="All memes"] > li').length === 1, null, { timeout: T.ui });
    expect(await all.getByRole('button', { name: fav, exact: true }).count()).toBe(1);

    // A's favorites are independent (local to each device).
    await goTab(a.page, 'Gallery');
    await a.page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: '★ Favorites' }).check();
    await a.page.getByRole('heading', { name: 'No favorites yet' }).waitFor({ timeout: T.ui });
  });
});
