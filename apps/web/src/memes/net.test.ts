import { describe, expect, it, vi } from 'vitest';
import { fetchWithFallback, makeProxyUrl, readCapped, routeOrder, RouteMemory } from './net';

const ok = () => new Response('ok');

describe('routeOrder', () => {
  it('tries the remembered route first', () => {
    expect(routeOrder(undefined, true)).toEqual(['direct', 'proxy']);
    expect(routeOrder('direct', true)).toEqual(['direct', 'proxy']);
    expect(routeOrder('proxy', true)).toEqual(['proxy', 'direct']);
    expect(routeOrder('proxy', false)).toEqual(['direct']);
  });
});

describe('fetchWithFallback', () => {
  it('remembers the proxy, and moves back to direct if the proxy later fails', async () => {
    const memory = new RouteMemory();
    let directBroken = true;
    let proxyBroken = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'D' && directBroken) throw new TypeError('Failed to fetch');
      if (url === 'P' && proxyBroken) throw new TypeError('relay down');
      return ok();
    }) as unknown as typeof fetch;
    const req = { fetchImpl, memory, key: 'k', directUrl: 'D', proxyUrl: 'P' };

    expect((await fetchWithFallback(req)).route).toBe('proxy');
    expect(memory.get('k')).toBe('proxy');
    expect((await fetchWithFallback(req)).route).toBe('proxy');
    expect(fetchImpl).toHaveBeenCalledTimes(3); // D, P, P

    directBroken = false;
    proxyBroken = true;
    expect((await fetchWithFallback(req)).route).toBe('direct');
    expect(memory.get('k')).toBe('direct');
  });

  it('keys are independent', async () => {
    const memory = new RouteMemory();
    memory.set('a', 'proxy');
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    const r = await fetchWithFallback({ fetchImpl, memory, key: 'b', directUrl: 'D', proxyUrl: 'P' });
    expect(r.route).toBe('direct');
  });

  it('returns a 404 from the first route without failing over', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const { res, route } = await fetchWithFallback({ fetchImpl, memory: new RouteMemory(), key: 'k', directUrl: 'D', proxyUrl: 'P' });
    expect([res.status, route]).toEqual([404, 'direct']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the last route response even if it is a 429, without remembering it', async () => {
    const memory = new RouteMemory();
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    const { res, route } = await fetchWithFallback({ fetchImpl, memory, key: 'k', directUrl: 'D', proxyUrl: 'P' });
    expect([res.status, route]).toEqual([429, 'proxy']);
    expect(memory.get('k')).toBeUndefined();
  });

  it('without a proxy, a network error is a MemeError(network)', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('x');
    }) as unknown as typeof fetch;
    await expect(
      fetchWithFallback({ fetchImpl, memory: new RouteMemory(), key: 'k', directUrl: 'D', proxyUrl: null }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('does not fail over on abort', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(
      fetchWithFallback({ fetchImpl, memory: new RouteMemory(), key: 'k', directUrl: 'D', proxyUrl: 'P' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('makeProxyUrl', () => {
  it('joins with the relay base, or stays same-origin when empty', () => {
    expect(makeProxyUrl(() => 'https://relay.example.com/')('/proxy/x')).toBe('https://relay.example.com/proxy/x');
    expect(makeProxyUrl(() => 'localhost:8787')('/proxy/x')).toBe('http://localhost:8787/proxy/x');
    expect(makeProxyUrl(() => '  ')('/proxy/x')).toBe('/proxy/x');
  });
});

describe('readCapped', () => {
  it('reads a streamed body', async () => {
    const bytes = await readCapped(new Response(new Uint8Array([1, 2, 3])), 10);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('rejects by Content-Length before reading', async () => {
    const res = new Response('x', { headers: { 'content-length': '999' } });
    await expect(readCapped(res, 10)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('rejects while streaming when the header lies or is missing', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(6));
        c.enqueue(new Uint8Array(6));
        c.close();
      },
    });
    await expect(readCapped(new Response(body), 10)).rejects.toMatchObject({ code: 'too-large' });
  });
});
