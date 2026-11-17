import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelay, type Relay } from '../src/relay';

let base: string;
let root: string;
let relay: Relay;

/** Raw GET that sends the path exactly as given (fetch would normalize ".."). */
function rawGet(p: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const u = new URL(relay.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: p, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'relay-static-'));
  root = path.join(base, 'dist');
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(base, 'secret.txt'), 'TOP SECRET');
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Meme Pals</title>');
  writeFileSync(path.join(root, 'sw.js'), 'self.addEventListener("fetch",()=>{})');
  writeFileSync(path.join(root, 'manifest.webmanifest'), '{"name":"Meme Pals"}');
  writeFileSync(path.join(root, 'assets', 'index-B2x9fQ_a.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'assets', 'index-B2x9fQ_a.css'), 'body{}');
  writeFileSync(path.join(root, 'icon.png'), 'png');
  writeFileSync(path.join(root, '.env'), 'SECRET=1');
  // Files that must never shadow API routes.
  writeFileSync(path.join(root, 'health'), 'static health');
  writeFileSync(path.join(root, 'config'), 'static config');
  mkdirSync(path.join(root, 'proxy'));
  writeFileSync(path.join(root, 'proxy', 'image'), 'static proxy');
  symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
  relay = await createRelay({ port: 0, staticDir: root });
});

afterAll(async () => {
  await relay.close();
  rmSync(base, { recursive: true, force: true });
});

describe('static files', () => {
  it('serves index.html at / with no-cache', async () => {
    const res = await fetch(`${relay.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('Meme Pals');
  });

  it('serves sw.js and the manifest with no-cache and correct types', async () => {
    const sw = await fetch(`${relay.url}/sw.js`);
    expect(sw.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const mf = await fetch(`${relay.url}/manifest.webmanifest`);
    expect(mf.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    expect(mf.headers.get('cache-control')).toBe('no-cache');
  });

  it('marks hashed assets immutable', async () => {
    const js = await fetch(`${relay.url}/assets/index-B2x9fQ_a.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const css = await fetch(`${relay.url}/assets/index-B2x9fQ_a.css`);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const png = await fetch(`${relay.url}/icon.png`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe('no-cache');
  });

  it('supports conditional requests', async () => {
    const first = await fetch(`${relay.url}/sw.js`);
    const etag = first.headers.get('etag')!;
    const again = await fetch(`${relay.url}/sw.js`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });

  it('falls back to index.html for SPA routes but not for missing assets', async () => {
    const route = await fetch(`${relay.url}/chat/thread`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('Meme Pals');
    expect((await fetch(`${relay.url}/assets/missing-abcdefgh.js`)).status).toBe(404);
  });

  it.each([
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/..%2fsecret.txt',
    '/..%5csecret.txt',
    '/%2e%2e%5csecret.txt',
    '/assets%2f..%2f..%2fsecret.txt',
    '/%00index.html',
    '/%E0%A4%A',
    '/link.txt',
    '/.env',
    '//etc/passwd',
  ])('blocks traversal: %s', async (p) => {
    const res = await rawGet(p);
    expect(res.body).not.toContain('TOP SECRET');
    expect(res.body).not.toContain('SECRET=1');
    expect(res.body).not.toContain('root:');
    if (res.status === 200) expect(res.body).toContain('Meme Pals'); // SPA fallback is fine
  });

  it('never lets static files shadow API routes', async () => {
    expect(await (await fetch(`${relay.url}/health`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${relay.url}/config`)).json()).toHaveProperty('iceServers');
    const img = await fetch(`${relay.url}/proxy/image`);
    expect(img.status).toBe(400);
    expect((await fetch(`${relay.url}/ws`)).status).toBe(426);
    expect((await fetch(`${relay.url}/proxy/whatever`)).status).toBe(404);
  });

  it('rejects non-GET methods on static routes', async () => {
    expect((await fetch(`${relay.url}/index.html`, { method: 'POST' })).status).toBe(405);
  });
});
