/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, type Relay } from '../../apps/relay/src/relay';
import { MEME_HOSTS, relayFetch, upstreamFor } from './upstream';

/**
 * Two-device harness: one Chromium, one in-process relay serving the production
 * build, and one browser context (own IndexedDB) per "phone".
 *
 * Playwright is the globally installed one (NODE_PATH), loaded loosely typed.
 */
const pw: any = createRequire(import.meta.url)('playwright');

export type Page = any;
export type BrowserContext = any;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST = path.join(ROOT, 'apps/web/dist');

/** Generous but bounded timeouts. */
export const T = { ui: 15_000, sync: 25_000 } as const;

/** Unique, grep-able tokens so privacy checks can't match by accident. */
let tokenSeq = 0;
export function token(prefix: string): string {
  tokenSeq++;
  return `${prefix}${Math.random().toString(36).slice(2, 8)}${tokenSeq}`;
}

export interface WsFrame {
  url: string;
  dir: 'sent' | 'received';
  payload: string | Buffer;
}

export interface NetLog {
  requests: { url: string; method: string; postData: Buffer | null; device: string }[];
  frames: (WsFrame & { device: string })[];
  /** Requests the route guard refused because they went to an unexpected host. */
  unexpected: string[];
}

export type MemeRoute = 'direct' | 'blocked';

export interface Device {
  name: string;
  context: BrowserContext;
  page: Page;
  /** How this device's direct requests to meme hosts behave. */
  memeRoute: MemeRoute;
  /** Meme-host URLs this device fetched directly (fulfilled by the mock). */
  directHits: string[];
  /** Open a fresh page in the same context (same IndexedDB) and load the app. */
  reopen(): Promise<Page>;
}

export interface DeviceOptions {
  serviceWorkers?: 'allow' | 'block';
  memeRoute?: MemeRoute;
  goto?: boolean;
  /** Extra Chromium flags (e.g. a fake camera). The device then gets its own browser process. */
  browserArgs?: string[];
  /** Permissions granted to the device's context, e.g. ['camera']. */
  permissions?: string[];
}

export interface Env {
  browser: any;
  relay: Relay;
  url: string;
  origin: string;
  log: NetLog;
  devices: Device[];
  newDevice(name: string, opts?: DeviceOptions): Promise<Device>;
  restartRelay(): Promise<void>;
  stopRelay(): Promise<void>;
  startRelay(): Promise<void>;
  close(): Promise<void>;
}

const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

function startRelay(port = 0): Promise<Relay> {
  return createRelay({
    port,
    staticDir: DIST,
    fetchImpl: relayFetch,
    // Unreachable local STUN: keeps WebRTC off the internet (host candidates suffice on localhost).
    iceServers: [{ urls: ['stun:127.0.0.1:9'] }],
  });
}

export async function startEnv(): Promise<Env> {
  const browser = await pw.chromium.launch();
  let relay = await startRelay();
  const port = relay.port;
  const url = relay.url;
  const origin = new URL(url).origin;
  const log: NetLog = { requests: [], frames: [], unexpected: [] };
  const devices: Device[] = [];
  /** Browsers launched for devices that need their own flags. */
  const extraBrowsers: any[] = [];

  function attachPage(page: Page, dev: Device) {
    page.on('websocket', (ws: any) => {
      const u = ws.url();
      ws.on('framesent', (f: any) => log.frames.push({ url: u, dir: 'sent', payload: f.payload, device: dev.name }));
      ws.on('framereceived', (f: any) => log.frames.push({ url: u, dir: 'received', payload: f.payload, device: dev.name }));
    });
    page.on('pageerror', (e: Error) => console.warn(`[${dev.name}] pageerror:`, e.message));
  }

  const env: Env = {
    browser,
    get relay() {
      return relay;
    },
    url,
    origin,
    log,
    devices,
    async newDevice(name, opts = {}) {
      let owner = browser;
      if (opts.browserArgs?.length) {
        owner = await pw.chromium.launch({ args: opts.browserArgs });
        extraBrowsers.push(owner);
      }
      const context = await owner.newContext({
        ...pw.devices['iPhone 13'],
        ...(opts.permissions ? { permissions: opts.permissions } : {}),
        // Service workers would hide requests from context.route; only the PWA test allows them.
        serviceWorkers: opts.serviceWorkers ?? 'block',
        acceptDownloads: true,
      });
      const dev: Device = {
        name,
        context,
        page: null,
        memeRoute: opts.memeRoute ?? 'direct',
        directHits: [],
        async reopen() {
          const p = await context.newPage();
          attachPage(p, dev);
          await p.goto(url);
          dev.page = p;
          return p;
        },
      };
      context.on('request', (r: any) =>
        log.requests.push({ url: r.url(), method: r.method(), postData: r.postDataBuffer(), device: name }),
      );
      await context.route('**/*', async (route: any) => {
        const req = route.request();
        const u = new URL(req.url());
        if (u.origin === origin) return route.continue();
        if ((MEME_HOSTS as readonly string[]).includes(u.hostname)) {
          if (dev.memeRoute === 'blocked') return route.abort('blockedbyclient');
          const r = upstreamFor(u.href);
          dev.directHits.push(u.href);
          if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': '*' } });
          return route.fulfill({ status: r!.status, headers: { ...r!.headers, ...CORS }, body: r!.body });
        }
        log.unexpected.push(u.href);
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      attachPage(page, dev);
      dev.page = page;
      devices.push(dev);
      if (opts.goto !== false) await page.goto(url);
      return dev;
    },
    async stopRelay() {
      await relay.close();
    },
    async startRelay() {
      relay = await startRelay(port);
    },
    async restartRelay() {
      await relay.close();
      relay = await startRelay(port);
    },
    async close() {
      for (const d of devices) await d.context.close().catch(() => {});
      for (const b of extraBrowsers) await b.close().catch(() => {});
      await browser.close().catch(() => {});
      await relay.close().catch(() => {});
    },
  };
  return env;
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

export async function onboard(page: Page, name: string): Promise<void> {
  await page.getByLabel(/What should your partner call you/).fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Pair with your partner' }).waitFor({ timeout: T.ui });
}

export async function enterChat(page: Page): Promise<void> {
  // The success screen auto-advances after ~1.4 s; clicking just makes it quicker.
  await page
    .getByRole('button', { name: 'Start chatting' })
    .click({ timeout: 3_000 })
    .catch(() => {});
  await page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: T.ui });
}

/** A shows a code, B types it. Both end up on the chat screen, connected. */
export async function pair(a: Device, b: Device): Promise<string> {
  await a.page.getByRole('button', { name: /Show my code/ }).click();
  const codeEl = a.page.locator('.pair-code');
  await codeEl.waitFor({ timeout: T.ui });
  const code = (await codeEl.textContent())!.trim();
  await b.page.getByRole('button', { name: /Join my partner/ }).click();
  await b.page.getByLabel('Pairing code').fill(code);
  await b.page.getByRole('button', { name: 'Join', exact: true }).click();
  await Promise.all([
    a.page.getByRole('heading', { name: "You're paired!" }).waitFor({ timeout: T.sync }),
    b.page.getByRole('heading', { name: "You're paired!" }).waitFor({ timeout: T.sync }),
  ]);
  await Promise.all([enterChat(a.page), enterChat(b.page)]);
  await Promise.all([waitOnline(a.page), waitOnline(b.page)]);
  return code;
}

/** New env-scoped pair of onboarded, paired phones. */
export async function pairedDevices(env: Env, names = [token('Ava'), token('Ben')]): Promise<[Device, Device]> {
  const [a, b] = await Promise.all([env.newDevice(names[0]!), env.newDevice(names[1]!)]);
  await Promise.all([onboard(a.page, a.name), onboard(b.page, b.name)]);
  await pair(a, b);
  return [a, b];
}

export const chatStatus = (page: Page) => page.locator('.chat-top .topbar-sub');

export async function waitOnline(page: Page, timeout: number = T.sync): Promise<void> {
  await page.locator('.chat-top .topbar-sub', { hasText: /^online$/ }).waitFor({ timeout });
}

export async function sendText(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

/** The <li> bubble that contains `text` (exact text match on the message paragraph). */
export function bubble(page: Page, text: string): any {
  return page
    .getByRole('list', { name: 'Messages' })
    .locator('li.msg')
    .filter({ has: page.locator('p.msg-text', { hasText: text }) });
}

export async function waitBubble(page: Page, text: string, timeout: number = T.sync): Promise<any> {
  const b = bubble(page, text);
  await b.first().waitFor({ timeout });
  return b;
}

export async function tickOf(li: any): Promise<string | null> {
  return li.locator('.tick').getAttribute('aria-label');
}

export async function waitTick(li: any, label: 'Sending' | 'Delivered' | 'Read', timeout: number = T.sync): Promise<void> {
  await li.locator(`.tick[aria-label="${label}"]`).waitFor({ timeout });
}

export async function goTab(page: Page, name: 'Chat' | 'Discover' | 'Make' | 'Gallery' | 'Settings'): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

/** Texts of all chat bubbles, in display order. */
export async function bubbleTexts(page: Page): Promise<string[]> {
  return page.getByRole('list', { name: 'Messages' }).locator('li.msg p.msg-text').allTextContents();
}

/** sha256 of the bytes behind an <img> (blob: URL) inside the page. */
export async function imgSha256(page: Page, img: any): Promise<string> {
  await img.waitFor({ timeout: T.sync });
  const src = await img.getAttribute('src');
  return page.evaluate(async (s: string) => {
    const buf = await (await fetch(s)).arrayBuffer();
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, src);
}

/** Read rows straight from the app's IndexedDB ("memes" DB). */
export async function idbAll(page: Page, store: string): Promise<any[]> {
  return page.evaluate(
    (s: string) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('memes');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(s, 'readonly');
          const req = tx.objectStore(s).getAll();
          req.onsuccess = () => {
            const rows = (req.result as any[]).map((r) => {
              const out: any = { ...r };
              if (r.data instanceof ArrayBuffer) out.data = r.data.byteLength;
              return out;
            });
            db.close();
            resolve(rows);
          };
          req.onerror = () => reject(req.error);
        };
      }),
    store,
  );
}

/** Poll until fn() is truthy. */
export async function until<T>(fn: () => Promise<T> | T, what: string, timeout: number = T.sync, every = 100): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
