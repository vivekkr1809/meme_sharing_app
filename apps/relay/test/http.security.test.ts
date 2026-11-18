import { describe, expect, it } from 'vitest';
import { createRelay } from '../src/relay';

/** Security review (A7): the proxies must not be usable as an unbounded bandwidth amplifier. */

describe('proxy concurrency limits', () => {
  it('answers 429 beyond the per-IP limit and recovers once requests finish', async () => {
    const pending: (() => void)[] = [];
    const fetchImpl = (async () => {
      await new Promise<void>((resolve) => pending.push(resolve));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const r = await createRelay({ port: 0, fetchImpl, proxyConcurrency: { perIp: 2, total: 10 } });
    const img = () => fetch(`${r.url}/proxy/image?url=${encodeURIComponent('https://i.redd.it/a.png')}`);
    try {
      const first = [img(), img()];
      while (pending.length < 2) await new Promise((res) => setTimeout(res, 5));
      const third = await img();
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBe('2');
      // Reddit/Imgflip share the same budget.
      expect((await fetch(`${r.url}/proxy/imgflip/get_memes`)).status).toBe(429);

      pending.splice(0).forEach((release) => release());
      for (const res of await Promise.all(first)) {
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
      const again = img();
      while (pending.length < 1) await new Promise((res) => setTimeout(res, 5));
      pending.splice(0).forEach((release) => release());
      expect((await again).status).toBe(200);
    } finally {
      pending.splice(0).forEach((release) => release());
      await r.close();
    }
  });

  it('applies a global cap across clients', async () => {
    const pending: (() => void)[] = [];
    const fetchImpl = (async () => {
      await new Promise<void>((resolve) => pending.push(resolve));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    // trustProxy: each X-Forwarded-For value counts as a different client.
    const r = await createRelay({ port: 0, fetchImpl, trustProxy: true, proxyConcurrency: { perIp: 5, total: 2 } });
    const get = (ip: string) => fetch(`${r.url}/proxy/imgflip/get_memes`, { headers: { 'x-forwarded-for': ip } });
    try {
      const first = [get('198.51.100.1'), get('198.51.100.2')];
      while (pending.length < 2) await new Promise((res) => setTimeout(res, 5));
      expect((await get('198.51.100.3')).status).toBe(429);
      pending.splice(0).forEach((release) => release());
      await Promise.all(first);
    } finally {
      pending.splice(0).forEach((release) => release());
      await r.close();
    }
  });
});
