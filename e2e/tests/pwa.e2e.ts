/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onboard, startEnv, T, type Env } from '../support/harness';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.close();
});

function pngSize(buf: Buffer): { w: number; h: number } {
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe('PWA', () => {
  it('the production build registers the service worker and serves a valid manifest', async () => {
    const d = await env.newDevice('pwa', { serviceWorkers: 'allow' });
    const page = d.page;
    await page.getByLabel(/What should your partner call you/).waitFor({ timeout: T.ui });

    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const w = reg.active!;
      if (w.state !== 'activated') {
        await new Promise<void>((r) => w.addEventListener('statechange', () => w.state === 'activated' && r()));
      }
      return { scope: reg.scope, script: reg.active?.scriptURL, state: reg.active?.state };
    });
    expect(sw.scope).toBe(env.url + '/');
    expect(sw.script).toBe(env.url + '/sw.js');
    expect(sw.state).toBe('activated');

    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();
    const manifestUrl = new URL(href!, env.url + '/').href;
    const res = await d.context.request.get(manifestUrl);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/application\/manifest\+json|application\/json/);
    const m = await res.json();
    expect(m).toMatchObject({ name: 'Meme Pals', short_name: 'Meme Pals', start_url: '/', scope: '/', display: 'standalone' });
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    // Installability: 192 and 512 "any" PNG icons, plus maskable ones; every icon is served and has the declared size.
    const pngs = m.icons.filter((i: any) => i.type === 'image/png');
    for (const size of ['192x192', '512x512']) {
      expect(pngs.some((i: any) => i.sizes === size && i.purpose.includes('any'))).toBe(true);
      expect(pngs.some((i: any) => i.sizes === size && i.purpose.includes('maskable'))).toBe(true);
    }
    for (const icon of m.icons) {
      const r = await d.context.request.get(new URL(icon.src, manifestUrl).href);
      expect(r.status(), icon.src).toBe(200);
      if (icon.type === 'image/png') {
        const { w, h } = pngSize(await r.body());
        expect(`${w}x${h}`).toBe(icon.sizes);
      }
    }
    await d.context.close();
  });

  it('with the device offline after the first load, the app shell still loads (and local storage works)', async () => {
    const d = await env.newDevice('pwa-offline', { serviceWorkers: 'allow' });
    const page = d.page;
    await page.evaluate(() => navigator.serviceWorker.ready);
    // clientsClaim: the page becomes controlled without a reload.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: T.ui });

    await d.context.setOffline(true);
    const resp = await page.reload();
    expect(resp?.fromServiceWorker()).toBe(true);
    await page.getByRole('heading', { name: 'Meme Pals' }).waitFor({ timeout: T.ui });
    // A deep link (SPA route) also comes from the precache.
    const deep = await page.goto(env.url + '/some/deep/link#/chat');
    expect(deep?.fromServiceWorker()).toBe(true);
    await onboard(page, 'Offline Olly');
    await page.getByRole('button', { name: /Show my code/ }).click();
    await page.locator('.pair-code').waitFor({ timeout: T.ui });
    // Can't reach the relay while offline: it says so instead of crashing.
    await page.getByRole('status').filter({ hasText: /Connecting to the relay|Not connected yet/ }).waitFor({ timeout: T.ui });
    await d.context.setOffline(false);
    await page.getByText('Waiting for your partner…').waitFor({ timeout: 45_000 });
    await d.context.close();
  });
});
