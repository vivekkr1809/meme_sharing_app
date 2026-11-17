// Renders the PWA PNG icons from the SVG sources in public/ using a headless Chromium.
// Run from apps/web:  NODE_PATH=$(npm root -g) node src/pwa/generate-icons.mjs
// (Playwright must be available globally; it is not a project dependency.)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const pub = join(dirname(fileURLToPath(import.meta.url)), '../../public');
const icon = readFileSync(join(pub, 'icons/icon.svg'), 'utf8');
const maskable = readFileSync(join(pub, 'icons/maskable.svg'), 'utf8');
// iOS rounds the corners itself, so the touch icon is full-bleed with slightly larger art.
const apple = maskable.replace('scale(0.7)', 'scale(0.84)');

const jobs = [
  { svg: icon, size: 192, out: 'icons/icon-192.png', transparent: true },
  { svg: icon, size: 512, out: 'icons/icon-512.png', transparent: true },
  { svg: maskable, size: 192, out: 'icons/maskable-192.png' },
  { svg: maskable, size: 512, out: 'icons/maskable-512.png' },
  { svg: apple, size: 180, out: 'apple-touch-icon.png' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const j of jobs) {
  await page.setViewportSize({ width: j.size, height: j.size });
  const src = 'data:image/svg+xml;base64,' + Buffer.from(j.svg).toString('base64');
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${src}" width="${j.size}" height="${j.size}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  await page.screenshot({ path: join(pub, j.out), omitBackground: !!j.transparent, clip: { x: 0, y: 0, width: j.size, height: j.size } });
  console.log('wrote', j.out);
}
await browser.close();
