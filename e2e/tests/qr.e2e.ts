import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plainPng, qrPng, writeQrY4m } from '../support/qr';
import { enterChat, onboard, sendText, startEnv, T, token, waitBubble, waitOnline, type Device, type Env, type Page } from '../support/harness';

/**
 * QR pairing for real: device B's Chromium has a fake camera that films device A's QR code
 * (a generated .y4m clip), or B picks a picture of the code from its "gallery".
 */

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.close();
});

const SHARE_WARNING = /Anyone with this code can pair with you until your partner joins/;

/** Records every camera stream the page opens, so we can check they are released. */
const RECORD_STREAMS = `(() => {
  const md = navigator.mediaDevices;
  window.__qr = { streams: [], constraints: [] };
  if (!md || !md.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    window.__qr.constraints.push(c);
    const s = await orig(c);
    window.__qr.streams.push(s);
    return s;
  };
})();`;

async function cameraDevice(name: string, showing: string): Promise<Device> {
  const clip = writeQrY4m(showing);
  const dev = await env.newDevice(name, {
    goto: false,
    permissions: ['camera'],
    browserArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`],
  });
  await dev.context.addInitScript(RECORD_STREAMS);
  await dev.page.goto(env.url);
  return dev;
}

/** A shows its code; returns the code text read from the page. */
async function showCode(a: Device): Promise<string> {
  await a.page.getByRole('button', { name: /Show my code/ }).click();
  const codeEl = a.page.locator('.pair-code');
  await codeEl.waitFor({ timeout: T.ui });
  const code = (await codeEl.textContent())!.trim();
  expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  await a.page.getByAltText(`QR code for pairing code ${code}`).waitFor({ timeout: T.ui });
  return code;
}

async function expectPairedAndChatting(a: Device, b: Device): Promise<void> {
  await Promise.all([
    a.page.getByRole('heading', { name: "You're paired!" }).waitFor({ timeout: T.sync }),
    b.page.getByRole('heading', { name: "You're paired!" }).waitFor({ timeout: T.sync }),
  ]);
  await Promise.all([enterChat(a.page), enterChat(b.page)]);
  await Promise.all([waitOnline(a.page), waitOnline(b.page)]);
  await a.page.getByRole('heading', { name: b.name, level: 1 }).waitFor({ timeout: T.ui });
  await b.page.getByRole('heading', { name: a.name, level: 1 }).waitFor({ timeout: T.ui });
  const [ab, ba] = [token('qr-hello-'), token('qr-reply-')];
  await sendText(a.page, ab);
  await waitBubble(b.page, ab);
  await sendText(b.page, ba);
  await waitBubble(a.page, ba);
}

async function detectorInfo(page: Page): Promise<{ native: boolean; secure: boolean }> {
  return page.evaluate(() => ({ native: 'BarcodeDetector' in window, secure: window.isSecureContext }));
}

describe('QR pairing', () => {
  it('shows a scannable code with the security note, black on white even in dark mode', async () => {
    const a = await env.newDevice(token('Ava'));
    await a.page.emulateMedia({ colorScheme: 'dark' });
    await onboard(a.page, a.name);
    const code = await showCode(a);
    const card = a.page.locator('.qr-card');
    await card.getByText(SHARE_WARNING).waitFor({ timeout: T.ui });
    await card.getByRole('button', { name: 'Copy' }).waitFor();
    await card.getByRole('button', { name: 'Save QR image' }).waitFor();

    const img = a.page.getByAltText(`QR code for pairing code ${code}`);
    const box = await img.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(240);
    const svg = decodeURIComponent((await img.getAttribute('src'))!.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
  });

  it('camera: B films A’s screen and joins automatically, then they chat', async () => {
    const a = await env.newDevice(token('Ava'));
    await onboard(a.page, a.name);
    const code = await showCode(a);

    const b = await cameraDevice(token('Ben'), code);
    await onboard(b.page, b.name);
    const info = await detectorInfo(b.page);
    console.log(`[qr.e2e] camera device: BarcodeDetector=${info.native} (so ${info.native ? 'native' : 'jsQR'} path), secureContext=${info.secure}`);
    await b.page.getByRole('button', { name: /Join my partner/ }).click();
    await b.page.getByRole('button', { name: /Scan QR code/ }).click();
    await b.page.getByLabel('Camera preview').waitFor({ timeout: T.ui });

    await expectPairedAndChatting(a, b);

    // The rear camera was asked for, and every track was released after the scan.
    const cam = await b.page.evaluate(() => {
      const q = (window as unknown as { __qr: { streams: MediaStream[]; constraints: MediaStreamConstraints[] } }).__qr;
      return {
        constraints: q.constraints,
        states: q.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
      };
    });
    expect(cam.constraints[0]).toMatchObject({ video: { facingMode: { ideal: 'environment' } } });
    expect(cam.states.length).toBeGreaterThan(0);
    expect(cam.states.every((s: string) => s === 'ended')).toBe(true);
  });

  it('camera: a QR code that isn’t a Meme Pals code is ignored', async () => {
    const b = await cameraDevice(token('Cal'), 'https://example.com/lunch-menu');
    await onboard(b.page, b.name);
    await b.page.getByRole('button', { name: /Join my partner/ }).click();
    await b.page.getByRole('button', { name: /Scan QR code/ }).click();
    await b.page.getByText('That QR code isn’t a Meme Pals code').waitFor({ timeout: T.sync });
    // Still scanning, nothing joined.
    expect(await b.page.getByLabel('Camera preview').isVisible()).toBe(true);
    expect(await b.page.getByText('Waiting for your partner…').count()).toBe(0);
    await b.page.getByRole('button', { name: /Type instead/ }).click();
    await b.page.getByLabel('Pairing code').waitFor({ timeout: T.ui });
    const states = await b.page.evaluate(() =>
      (window as unknown as { __qr: { streams: MediaStream[] } }).__qr.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    );
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s: string) => s === 'ended')).toBe(true);
  });

  it('photo: B picks a screenshot of A’s code and joins', async () => {
    const a = await env.newDevice(token('Ava'));
    await onboard(a.page, a.name);
    const code = await showCode(a);

    const b = await env.newDevice(token('Ben'));
    await onboard(b.page, b.name);
    await b.page.getByRole('button', { name: /Join my partner/ }).click();
    // A phone-sized screenshot with the QR off-centre on a grey UI.
    const png = qrPng(code, { width: 750, height: 1334, scale: 6, x: 120, y: 520 });
    await b.page.locator('input[type=file]').setInputFiles({ name: 'Screenshot.png', mimeType: 'image/png', buffer: png });
    await expectPairedAndChatting(a, b);
  });

  it('photo: the “Save QR image” download pairs too; other pictures are rejected', async () => {
    const a = await env.newDevice(token('Ava'));
    await onboard(a.page, a.name);
    const code = await showCode(a);
    const [download] = await Promise.all([a.page.waitForEvent('download'), a.page.getByRole('button', { name: 'Save QR image' }).click()]);
    expect(download.suggestedFilename()).toBe('meme-pals-pairing-code.png');
    const saved = readFileSync(await download.path());
    expect(saved.subarray(1, 4).toString('ascii')).toBe('PNG');

    const b = await env.newDevice(token('Ben'));
    await onboard(b.page, b.name);
    await b.page.getByRole('button', { name: /Join my partner/ }).click();
    const input = b.page.locator('input[type=file]');

    // Someone else's QR code: a clear message, no join.
    await input.setInputFiles({ name: 'menu.png', mimeType: 'image/png', buffer: qrPng('https://example.com/lunch-menu') });
    await b.page.getByRole('alert').filter({ hasText: 'That QR code isn’t a Meme Pals code' }).waitFor({ timeout: T.ui });
    // A picture with no QR code at all.
    await input.setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: plainPng() });
    await b.page.getByRole('alert').filter({ hasText: 'Couldn’t find a QR code' }).waitFor({ timeout: T.ui });
    expect(await b.page.getByText('Waiting for your partner…').count()).toBe(0);

    await input.setInputFiles({ name: 'meme-pals-pairing-code.png', mimeType: 'image/png', buffer: saved });
    await expectPairedAndChatting(a, b);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  });
});
