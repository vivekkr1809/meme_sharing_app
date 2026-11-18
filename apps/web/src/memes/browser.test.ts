/**
 * Real-browser tests for the image tools: headless Chromium (Playwright, from the
 * global install via NODE_PATH) driving src/memes/harness/ served by a Vite dev server.
 * All non-local network access is blocked; remote hosts are mocked with page.route.
 * If Chromium can't be launched here, every test is skipped with the reason.
 */
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import type { MemeTemplate } from '../contracts';
import type { ImageSummary } from './harness/harness';

// ─── A tiny PNG encoder for the template fixture ────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Opaque RGB PNG with a mid-tone gradient (no pure white/black, so caption ink is detectable). */
function makeTemplatePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = 60 + Math.round((140 * x) / w);
      raw[o + 1] = 90;
      raw[o + 2] = 60 + Math.round((140 * y) / h);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEMPLATE_W = 500;
const TEMPLATE_H = 400;
const TEMPLATE_PNG = makeTemplatePng(TEMPLATE_W, TEMPLATE_H);

/** Serves /__fixtures/template.png from the dev server itself. */
const fixturesPlugin: Plugin = {
  name: 'memes-test-fixtures',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] === '/__fixtures/template.png') {
        res.setHeader('content-type', 'image/png');
        res.setHeader('content-length', String(TEMPLATE_PNG.length));
        res.end(TEMPLATE_PNG);
        return;
      }
      next();
    });
  },
};

// ─── Loosely-typed Playwright ───────────────────────────────────────────────

type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Route = { request(): { url(): string }; abort(code?: string): Promise<void>; fulfill(r: any): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  route(match: string | RegExp | ((url: URL) => boolean), handler: (route: Route) => unknown): Promise<void>;
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  waitForFunction(fn: () => unknown, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
  on(event: string, cb: (x: any) => void): void;
};

const webRoot = fileURLToPath(new URL('../..', import.meta.url));

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let origin = '';
let skipReason = '';
const requests: string[] = [];
const pageErrors: string[] = [];

beforeAll(async () => {
  let chromium: { launch(): Promise<Browser> };
  try {
    chromium = (createRequire(import.meta.url)('playwright') as { chromium: typeof chromium }).chromium;
  } catch (err) {
    skipReason = `playwright is not installed/resolvable (NODE_PATH=${process.env.NODE_PATH ?? ''}): ${String(err)}`;
    return;
  }
  try {
    browser = await chromium.launch();
  } catch (err) {
    skipReason = `Chromium could not be launched in this environment: ${String(err).split('\n')[0]}`;
    return;
  }

  server = await createServer({
    root: webRoot,
    configFile: false, // don't pick up vite.config.ts (its /proxy rule would forward to a relay)
    logLevel: 'error',
    clearScreen: false,
    plugins: [fixturesPlugin],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  const addr = server.httpServer!.address() as AddressInfo;
  origin = `http://127.0.0.1:${addr.port}`;

  page = await browser.newPage();
  page.on('pageerror', (e: Error) => pageErrors.push(String(e)));
  // Block everything that isn't the dev server. (Later routes take precedence.)
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      requests.push(route.request().url());
      await route.abort('failed');
    },
  );
  // The relay's /proxy/image, mocked: serves the template for allow-listed hosts.
  await page.route(
    (url) => url.origin === origin && url.pathname === '/proxy/image',
    async (route) => {
      const url = route.request().url();
      requests.push(url);
      const target = new URL(new URL(url).searchParams.get('url') ?? '');
      if (target.hostname !== 'i.imgflip.com') return route.fulfill({ status: 403, body: 'host not allowed' });
      await route.fulfill({ status: 200, contentType: 'image/png', body: TEMPLATE_PNG });
    },
  );
  await page.goto(`${origin}/src/memes/harness/index.html?relay=${encodeURIComponent(origin)}`);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', undefined, { timeout: 30_000 });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('image tools in Chromium', () => {
  const run = <T>(ctx: { skip: (note?: string) => void }, fn: (p: Page) => Promise<T>): Promise<T> | undefined => {
    if (!page) {
      console.warn(`[memes browser test] SKIPPED: ${skipReason}`);
      ctx.skip(skipReason);
      return undefined;
    }
    return fn(page);
  };

  it('processUpload: resizes a large EXIF-rotated JPEG to ≤1600px, applies orientation, strips EXIF', async (ctx) => {
    await run(ctx, async (p) => {
      const r = await p.evaluate(async () => {
        const h = window.memeHarness;
        const input = await h.makeJpegWithExif(3000, 2000, 6); // 6 = rotate 90° CW → displays as 2000×3000
        const inputHasExif = await h.containsExif(input);
        const out = await h.services.images.processUpload(input);
        return { inputHasExif, out: await h.summarize(out) };
      });
      expect(r.inputHasExif).toBe(true);
      const out: ImageSummary = r.out;
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1600);
      expect([out.width, out.height]).toEqual([1067, 1600]); // portrait: orientation respected
      expect([out.decodedWidth, out.decodedHeight]).toEqual([out.width, out.height]);
      expect(out.exif).toBe(false);
      expect(out.mime).toBe('image/webp'); // Chromium encodes WebP
      expect(out.sniffed).toBe(out.mime);
      expect(out.blobType).toBe(out.mime);
    });
  });

  it('processUpload: keeps a small image at its size and keeps PNG transparency', async (ctx) => {
    await run(ctx, async (p) => {
      const r = await p.evaluate(async () => {
        const h = window.memeHarness;
        const out = await h.services.images.processUpload(await h.makeTransparentPng(200, 100));
        return { out: await h.summarize(out), left: await h.pixelAt(out.blob, 10, 50), right: await h.pixelAt(out.blob, 190, 50) };
      });
      expect([r.out.width, r.out.height]).toEqual([200, 100]);
      expect(r.left[3]).toBeLessThan(20); // still transparent
      expect(r.right[3]).toBe(255);
    });
  });

  it('processUpload: passes GIFs through byte-for-byte', async (ctx) => {
    await run(ctx, async (p) => {
      const r = await p.evaluate(async () => {
        const h = window.memeHarness;
        const out = await h.services.images.processUpload(h.tinyGif());
        return { mime: out.mime, width: out.width, height: out.height, bytes: await h.bytesOf(out.blob), original: h.tinyGifBytes() };
      });
      expect(r).toMatchObject({ mime: 'image/gif', width: 1, height: 1 });
      expect(r.bytes).toEqual(r.original);
    });
  });

  it('fetchImage: downloads from the dev server, sniffs and decodes', async (ctx) => {
    await run(ctx, async (p) => {
      const out = await p.evaluate(
        async (url) => window.memeHarness.summarize(await window.memeHarness.services.images.fetchImage(url)),
        `${origin}/__fixtures/template.png`,
      );
      expect(out).toMatchObject({ mime: 'image/png', sniffed: 'image/png', width: TEMPLATE_W, height: TEMPLATE_H });
      expect(out.size).toBe(TEMPLATE_PNG.length);
    });
  });

  it('fetchImage: falls back to the relay /proxy/image when the direct request fails', async (ctx) => {
    await run(ctx, async (p) => {
      requests.length = 0;
      const out = await p.evaluate(
        async (url) => window.memeHarness.summarize(await window.memeHarness.services.images.fetchImage(url)),
        'https://i.imgflip.com/fake123.png',
      );
      expect(out).toMatchObject({ mime: 'image/png', width: TEMPLATE_W, height: TEMPLATE_H });
      expect(requests).toEqual([
        'https://i.imgflip.com/fake123.png',
        `${origin}/proxy/image?url=${encodeURIComponent('https://i.imgflip.com/fake123.png')}`,
      ]);
    });
  });

  it('renderMeme: draws captions on a locally-served template and returns a decodable image', async (ctx) => {
    await run(ctx, async (p) => {
      const template: MemeTemplate = {
        id: 't1',
        name: 'Test template',
        url: `${origin}/__fixtures/template.png`,
        width: TEMPLATE_W,
        height: TEMPLATE_H,
        boxCount: 2,
      };
      const r = await p.evaluate(async (t) => {
        const h = window.memeHarness;
        const [top, bottom] = h.services.images.defaultBoxes(t);
        const out = await h.services.images.renderMeme(t, [
          { ...top!, text: 'one does not simply' },
          { ...bottom!, text: '' },
        ]);
        const W = out.width;
        const H = out.height;
        return {
          out: await h.summarize(out),
          topInk: await h.captionInk(out.blob, { x: 0, y: 0, w: W, h: Math.round(H * 0.27) }),
          bottomInk: await h.captionInk(out.blob, { x: 0, y: Math.round(H * 0.73), w: W, h: Math.round(H * 0.27) - 1 }),
        };
      }, template);
      expect(r.out).toMatchObject({ width: TEMPLATE_W, height: TEMPLATE_H, decodedWidth: TEMPLATE_W, decodedHeight: TEMPLATE_H });
      expect(['image/webp', 'image/jpeg']).toContain(r.out.mime);
      expect(r.out.sniffed).toBe(r.out.mime);
      // White fill + black outline in the top box; the empty bottom box stays untouched.
      expect(r.topInk.white).toBeGreaterThan(0.02);
      expect(r.topInk.black).toBeGreaterThan(0.01);
      expect(r.bottomInk.white).toBeLessThan(0.001);
      expect(r.bottomInk.black).toBeLessThan(0.001);
    });
  });

  it('renderMeme: template fetched through the proxy fallback still renders (canvas not tainted)', async (ctx) => {
    await run(ctx, async (p) => {
      const out = await p.evaluate(async () => {
        const h = window.memeHarness;
        const t = { id: 'x', name: 'x', url: 'https://i.imgflip.com/other.png', width: 500, height: 400, boxCount: 2 };
        const boxes = h.services.images.defaultBoxes(t).map((b, i) => ({ ...b, text: i ? 'bottom' : 'top' }));
        return h.summarize(await h.services.images.renderMeme(t, boxes));
      });
      expect(out).toMatchObject({ width: TEMPLATE_W, height: TEMPLATE_H });
      expect(pageErrors).toEqual([]);
    });
  });

  it('fetchImage: rejects non-images and does not proxy non-allow-listed hosts', async (ctx) => {
    await run(ctx, async (p) => {
      requests.length = 0;
      const r = await p.evaluate(async (base) => {
        const h = window.memeHarness;
        const codes: string[] = [];
        for (const url of [`${base}/src/memes/harness/index.html`, 'https://example.com/meme.png']) {
          try {
            await h.services.images.fetchImage(url);
            codes.push('ok');
          } catch (e) {
            codes.push((e as { code?: string }).code ?? String(e));
          }
        }
        return codes;
      }, origin);
      expect(r).toEqual(['unsupported-type', 'network']);
      expect(requests).toEqual(['https://example.com/meme.png']);
    });
  });
});
