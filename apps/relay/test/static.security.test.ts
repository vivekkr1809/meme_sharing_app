import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRelay, type Relay } from '../src/relay';
import { contentSecurityPolicy } from '../src/static';

/** Security review (A7): response headers of the served PWA, and proxy allow-list edge cases. */

let base: string;
let relay: Relay;

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values];
    }),
  );
}

beforeAll(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'relay-sec-'));
  mkdirSync(path.join(base, 'assets'));
  writeFileSync(path.join(base, 'index.html'), '<!doctype html><title>Meme Pals</title>');
  writeFileSync(path.join(base, 'sw.js'), '');
  writeFileSync(path.join(base, 'assets', 'index-B2x9fQ_a.js'), '');
  relay = await createRelay({ port: 0, staticDir: base, cspConnectSrc: ['https://other-relay.example', "'unsafe-eval';", 'https://x;script-src'] });
});

afterAll(async () => {
  await relay.close();
  rmSync(base, { recursive: true, force: true });
});

describe('static security headers', () => {
  it.each(['/', '/chat', '/sw.js', '/assets/index-B2x9fQ_a.js', '/.env'])('sends the full set on %s', async (p) => {
    const res = await fetch(relay.url + p);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('permissions-policy')).toContain('camera=(self)');
    expect(res.headers.get('permissions-policy')).toContain('microphone=()');
  });

  it('has a strict script policy and no framing', async () => {
    const d = directives((await fetch(relay.url + '/')).headers.get('content-security-policy')!);
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    const img = d.get('img-src')!;
    expect(img).toEqual(expect.arrayContaining(["'self'", 'blob:', 'data:', 'https://i.redd.it', 'https://preview.redd.it', 'https://i.imgflip.com']));
    expect(img.some((s) => s === '*' || s === 'https:' || s === 'http:')).toBe(false);
    const connect = d.get('connect-src')!;
    expect(connect).toEqual(expect.arrayContaining(["'self'", 'https://www.reddit.com', 'https://api.imgflip.com', 'wss:', 'https://other-relay.example']));
    expect(connect.some((s) => s === '*' || s === 'https:')).toBe(false);
  });

  it('drops operator-supplied connect-src tokens that could inject directives', () => {
    const csp = contentSecurityPolicy(["'unsafe-eval';", 'https://x;script-src', 'https://ok.example']);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('https://x');
    expect(csp).toContain('https://ok.example');
    expect(directives(csp).get('script-src')).toEqual(["'self'"]);
  });
});

describe('image proxy allow-list edge cases', () => {
  it.each([
    'https://i.redd.it./a.png', // trailing dot (FQDN form)
    'https://xn--i-ufa.redd.it/a.png', // IDN look-alike
    'https://[::1]/a.png',
    'https://127.0.0.1/a.png',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
  ])('refuses %s without contacting it', async (target) => {
    const fetchImpl = vi.fn(async () => new Response('x', { headers: { 'content-type': 'image/png' } }));
    const r = await createRelay({ port: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    try {
      const res = await fetch(`${r.url}/proxy/image?url=${encodeURIComponent(target)}`);
      expect([400, 403]).toContain(res.status);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await r.close();
    }
  });
});
