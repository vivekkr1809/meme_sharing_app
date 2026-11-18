// Captures iPhone-sized screenshots of every screen using the mock ("demo") services.
//
//   pnpm --filter @memes/web dev            # in another terminal (http://localhost:5173)
//   NODE_PATH=$(npm root -g) node docs/screenshots/capture.mjs [outDir] [--all]
//
// Without --all only the curated README set is written. Playwright must be available
// globally (it is not a project dependency).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const args = process.argv.slice(2);
const all = args.includes('--all');
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.APP_URL ?? 'http://localhost:5173';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const errors = [];

async function ctx(colorScheme = 'light') {
  const c = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 2, colorScheme });
  const page = await c.newPage();
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${page.url()}: console: ${m.text()}`));
  return { c, page };
}

const shot = async (page, name, curated = false) => {
  if (!curated && !all) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log('📸', name);
};

// 1. Onboarding → pairing
{
  const { c, page } = await ctx();
  await page.goto(`${BASE}/?demo`);
  await page.getByLabel('What should your partner call you?').waitFor();
  await shot(page, '01-onboarding', true);
  await page.getByLabel('What should your partner call you?').fill('Jordan');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Show my code/ }).waitFor();
  await shot(page, 'pairing-choose');
  await page.getByRole('button', { name: /Show my code/ }).click();
  await page.getByAltText(/QR code for pairing code/).waitFor();
  await page.getByText('Waiting for your partner…').waitFor();
  await shot(page, '02-pairing', true);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: /Join my partner/ }).click();
  await page.getByLabel('Pairing code').fill('NOT-A-REAL-CODE');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await shot(page, 'pairing-join-error');
  await c.close();
}

// 2. Main screens with a seeded, paired conversation
for (const scheme of ['light', 'dark']) {
  const dark = scheme === 'dark';
  const { c, page } = await ctx(scheme);
  await page.goto(`${BASE}/?demo=paired#/chat`);
  await page.locator('.msg').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.msg .meme-img').length >= 3);
  await page.waitForTimeout(1500);
  await shot(page, dark ? '06-chat-dark' : '03-chat', true);
  if (dark) {
    await page.getByRole('button', { name: 'Discover' }).click();
    await page.locator('.tile').nth(3).waitFor();
    await page.waitForTimeout(500);
    await shot(page, 'discover-dark');
    await page.getByRole('button', { name: 'Settings' }).click();
    await shot(page, 'settings-dark');
    await c.close();
    continue;
  }

  // Reaction tray via long-press (context menu on desktop)
  await page.locator('.msg.theirs .bubble').last().click({ button: 'right' });
  await page.getByRole('toolbar', { name: 'Message actions' }).waitFor();
  await shot(page, 'chat-reaction-tray');
  await page.getByRole('button', { name: 'React with 🔥' }).click();
  // Reply + send
  await page.locator('.msg.theirs .bubble').last().click({ button: 'right' });
  await page.getByRole('toolbar').getByRole('button', { name: 'Reply' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('haha you know it 😎');
  await shot(page, 'chat-replying');
  await page.keyboard.press('Enter');
  await page.getByLabel(/is typing/).waitFor({ timeout: 8000 }).catch(() => {});
  await shot(page, 'chat-typing');
  await page.waitForTimeout(3500);
  await shot(page, 'chat-after-reply');
  // Meme viewer
  await page.locator('.meme-btn').last().click();
  await page.locator('.viewer-img').waitFor();
  await shot(page, 'chat-viewer');
  await page.keyboard.press('Escape');

  // Discover
  await page.getByRole('button', { name: 'Discover' }).click();
  await page.locator('.tile').nth(3).waitFor();
  await page.waitForTimeout(500);
  await shot(page, '04-discover', true);
  await page.locator('.tile').first().click();
  await page.locator('.sheet-media img').waitFor();
  await shot(page, 'discover-sheet');
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Top' }).check({ force: true });
  await page.locator('.discover-scroll').evaluate((el) => el.scrollTo(0, 99999));
  await page.waitForTimeout(1600);
  await shot(page, 'discover-scrolled');

  // Make
  await page.getByRole('button', { name: 'Make' }).click();
  await page.locator('.template').first().waitFor();
  await shot(page, 'make-templates');
  await page.getByRole('button', { name: 'Smug Frog' }).click();
  await page.getByLabel('Top text').fill('me after fixing one bug');
  await page.getByLabel('Bottom text').fill('time to refactor everything');
  await page.waitForTimeout(900);
  await shot(page, '05-make', true);
  await page.getByRole('button', { name: 'Back to templates' }).click();

  // Gallery
  await page.getByRole('button', { name: 'Gallery' }).click();
  await page.locator('.gallery-tile').first().waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'gallery');
  await page.getByRole('radio', { name: /Favorites/ }).check({ force: true });
  await page.waitForTimeout(300);
  await shot(page, 'gallery-favorites');
  await page.locator('.gallery-tile').first().click();
  await page.locator('.viewer-img').waitFor();
  await shot(page, 'gallery-viewer');
  await page.keyboard.press('Escape');

  // Settings
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('Display name').waitFor();
  await shot(page, 'settings');
  await page.locator('.settings-scroll').evaluate((el) => el.scrollTo(0, 700));
  await shot(page, 'settings-2');
  await page.locator('.settings-scroll').evaluate((el) => el.scrollTo(0, 99999));
  await shot(page, 'settings-3');
  await page.getByRole('button', { name: 'Wipe all data' }).click();
  await shot(page, 'settings-wipe-confirm');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await c.close();
}

// 3. Partner offline banner
{
  const { c, page } = await ctx();
  await page.goto(`${BASE}/?demo=paired&partner=offline#/chat`);
  await page.locator('.banner').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, 'chat-offline');
  await page.getByRole('textbox', { name: 'Message' }).fill('are you there?');
  await page.keyboard.press('Enter');
  await shot(page, 'chat-offline-pending');
  await c.close();
}

// 4. Desktop layout
if (all) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await c.newPage();
  await page.goto(`${BASE}/?demo=paired#/discover`);
  await page.locator('.tile').nth(3).waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, 'desktop-discover.png') });
  console.log('📸 desktop-discover');
  await c.close();
}

await browser.close();
if (errors.length) {
  console.log('\nPage errors:\n' + errors.join('\n'));
  process.exitCode = 1;
}
