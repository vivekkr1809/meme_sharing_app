import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROXY_MAX_IMAGE_BYTES } from '@memes/shared';
import { createRelay, iceServersFromEnv, type Relay, type RelayOptions } from '../src/relay';

let relay: Relay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (...[input, init]: FetchArgs) => handler(new URL(String(input)), init));
}

async function start(opts: RelayOptions = {}) {
  relay = await createRelay({ port: 0, ...opts });
  return relay;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=UTF-8' }, ...init });

function expectApiHeaders(res: Response) {
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('cache-control')).toBe('no-store');
}

describe('basic endpoints', () => {
  it('GET /health', async () => {
    const r = await start();
    const res = await fetch(`${r.url}/health`);
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /config advertises default STUN servers', async () => {
    const r = await start();
    const res = await fetch(`${r.url}/config`);
    expectApiHeaders(res);
    expect(await res.json()).toEqual({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
    });
  });

  it('GET /config advertises configured TURN servers', async () => {
    const iceServers = iceServersFromEnv({
      STUN_URLS: 'stun:stun.example.com:3478',
      TURN_URLS: 'turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349,https://bogus',
      TURN_USERNAME: 'pal',
      TURN_CREDENTIAL: 'secret',
    });
    const r = await start({ iceServers });
    expect(await (await fetch(`${r.url}/config`)).json()).toEqual({
      iceServers: [
        { urls: ['stun:stun.example.com:3478'] },
        {
          urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'],
          username: 'pal',
          credential: 'secret',
        },
      ],
    });
  });

  it('iceServersFromEnv defaults and "none"', () => {
    expect(iceServersFromEnv({})).toEqual([
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    ]);
    expect(iceServersFromEnv({ STUN_URLS: 'none' })).toEqual([]);
  });

  it('answers CORS preflight and rejects other methods', async () => {
    const r = await start();
    const pre = await fetch(`${r.url}/proxy/imgflip/get_memes`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
    const post = await fetch(`${r.url}/health`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('returns 426 for plain HTTP on /ws and 404 for unknown API routes', async () => {
    const r = await start();
    expect((await fetch(`${r.url}/ws`)).status).toBe(426);
    expect((await fetch(`${r.url}/proxy/nope`)).status).toBe(404);
    expect((await fetch(`${r.url}/anything`)).status).toBe(404); // no staticDir
  });
});

describe('reddit proxy', () => {
  it('proxies a valid listing with a generic UA and only whitelisted params', async () => {
    const fetchImpl = mockFetch(() => json({ kind: 'Listing', data: { children: [] } }));
    const r = await start({ fetchImpl: fetchImpl as typeof fetch });
    const res = await fetch(`${r.url}/proxy/reddit/r/me_irl/top.json?after=t3_abc123&limit=25&t=week&evil=1`, {
      headers: { cookie: 'session=1', 'user-agent': 'client-ua' },
    });
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ kind: 'Listing', data: { children: [] } });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe('https://www.reddit.com/r/me_irl/top.json');
    expect(Object.fromEntries(u.searchParams)).toEqual({ raw_json: '1', limit: '25', after: 't3_abc123', t: 'week' });
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('MemePalsRelay/0.1');
    expect(headers.get('cookie')).toBeNull();
    expect(init?.redirect).toBe('manual');
  });

  it.each([
    ['/proxy/reddit/r/a/hot.json', 'bad-subreddit'],
    ['/proxy/reddit/r/bad-name/hot.json', 'bad-subreddit'],
    ['/proxy/reddit/r/' + 'x'.repeat(33) + '/hot.json', 'bad-subreddit'],
    ['/proxy/reddit/r/memes%2F..%2Fapi/hot.json', 'bad-subreddit'],
    ['/proxy/reddit/r/memes/best.json', 'bad-sort'],
    ['/proxy/reddit/r/memes/hot.json?limit=101', 'bad-limit'],
    ['/proxy/reddit/r/memes/hot.json?limit=0', 'bad-limit'],
    ['/proxy/reddit/r/memes/hot.json?limit=abc', 'bad-limit'],
    ['/proxy/reddit/r/memes/hot.json?after=../../x', 'bad-after'],
    ['/proxy/reddit/r/memes/hot.json?t=forever', 'bad-t'],
  ])('rejects %s', async (path, error) => {
    const fetchImpl = vi.fn();
    const r = await start({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await fetch(r.url + path);
    expect(res.status).toBe(400);
    expectApiHeaders(res);
    expect(await res.json()).toEqual({ error });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts limit=100 and every allowed sort', async () => {
    const fetchImpl = mockFetch(() => json({ ok: 1 }));
    const r = await start({ fetchImpl: fetchImpl as typeof fetch });
    for (const sort of ['hot', 'new', 'top', 'rising']) {
      expect((await fetch(`${r.url}/proxy/reddit/r/memes/${sort}.json?limit=100`)).status).toBe(200);
    }
  });

  it('refuses non-JSON upstream bodies', async () => {
    const r = await start({
      fetchImpl: mockFetch(() => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch,
    });
    const res = await fetch(`${r.url}/proxy/reddit/r/memes/hot.json`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream-not-json' });
  });

  it('refuses invalid JSON even with a JSON content-type', async () => {
    const r = await start({
      fetchImpl: mockFetch(() => new Response('{nope', { headers: { 'content-type': 'application/json' } })) as typeof fetch,
    });
    expect((await fetch(`${r.url}/proxy/reddit/r/memes/hot.json`)).status).toBe(502);
  });

  it('passes through 4xx status codes and maps 5xx to 502', async () => {
    let status = 404;
    const r = await start({ fetchImpl: mockFetch(() => json({ error: status }, { status })) as typeof fetch });
    expect((await fetch(`${r.url}/proxy/reddit/r/memes/hot.json`)).status).toBe(404);
    status = 503;
    expect((await fetch(`${r.url}/proxy/reddit/r/memes/hot.json`)).status).toBe(502);
  });

  it('does not follow redirects off reddit', async () => {
    const fetchImpl = mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.json' } }));
    const r = await start({ fetchImpl: fetchImpl as typeof fetch });
    const res = await fetch(`${r.url}/proxy/reddit/r/memes/hot.json`);
    expect(res.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out slow upstreams with 504', async () => {
    const fetchImpl = vi.fn(
      (_input: FetchArgs[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const r = await start({ fetchImpl: fetchImpl as typeof fetch, upstreamTimeoutMs: 50 });
    const res = await fetch(`${r.url}/proxy/reddit/r/memes/hot.json`);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'upstream-timeout' });
  });

  it('reports network failures as 502', async () => {
    const r = await start({
      fetchImpl: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect((await fetch(`${r.url}/proxy/reddit/r/memes/hot.json`)).status).toBe(502);
  });
});

describe('imgflip proxy', () => {
  it('proxies get_memes', async () => {
    const body = { success: true, data: { memes: [{ id: '1', name: 'Drake' }] } };
    const fetchImpl = mockFetch(() => json(body));
    const r = await start({ fetchImpl: fetchImpl as typeof fetch });
    const res = await fetch(`${r.url}/proxy/imgflip/get_memes?x=1`);
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(await res.json()).toEqual(body);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.imgflip.com/get_memes');
  });
});

describe('image proxy', () => {
  const img = (bytes: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    new Response(bytes, { headers: { 'content-type': 'image/png', ...headers } });
  const imageUrl = (r: Relay, target: string) => `${r.url}/proxy/image?url=${encodeURIComponent(target)}`;

  it('streams an allow-listed image with CORS and no-store', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const fetchImpl = mockFetch(() => img(bytes, { 'content-length': String(bytes.length), 'set-cookie': 'a=b' }));
    const r = await start({ fetchImpl: fetchImpl as typeof fetch });
    const res = await fetch(imageUrl(r, 'https://i.redd.it/abc.png'));
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('user-agent')).toBe('MemePalsRelay/0.1');
  });

  it.each([
    ['https://evil.example/a.png', 403],
    ['https://i.redd.it.evil.example/a.png', 403],
    ['https://evil.example/?u=https://i.redd.it/a.png', 403],
    ['https://i.redd.it@evil.example/a.png', 400],
    ['https://user:pw@i.redd.it/a.png', 400],
    ['http://i.redd.it/a.png', 400],
    ['https://i.redd.it:8443/a.png', 400],
    ['ftp://i.redd.it/a.png', 400],
    ['not a url', 400],
    ['', 400],
  ])('rejects %s', async (target, status) => {
    const fetchImpl = vi.fn();
    const r = await start({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await fetch(imageUrl(r, target));
    expect(res.status).toBe(status);
    expectApiHeaders(res);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts every allow-listed host', async () => {
    const fetchImpl = mockFetch(() => img(new Uint8Array([1])));
    const r = await start({ fetchImpl: fetchImpl as typeof fetch });
    for (const host of ['i.redd.it', 'preview.redd.it', 'external-preview.redd.it', 'i.imgur.com', 'i.imgflip.com']) {
      expect((await fetch(imageUrl(r, `https://${host}/x.jpg`))).status).toBe(200);
    }
  });

  it.each(['text/html', 'application/octet-stream', 'image/svg+xml', ''])('rejects content-type "%s"', async (type) => {
    const r = await start({
      fetchImpl: mockFetch(() => new Response('<svg onload=alert(1)>', { headers: { 'content-type': type } })) as typeof fetch,
    });
    const res = await fetch(imageUrl(r, 'https://i.imgur.com/a.png'));
    expect(res.status).toBe(415);
  });

  it('rejects a declared content-length above the cap', async () => {
    const r = await start({
      fetchImpl: mockFetch(() => img(new Uint8Array(4), { 'content-length': String(PROXY_MAX_IMAGE_BYTES + 1) })) as typeof fetch,
    });
    const res = await fetch(imageUrl(r, 'https://i.imgur.com/a.png'));
    expect(res.status).toBe(413);
  });

  it('aborts a streamed body that grows past the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        if (pulled > 40) ctrl.close();
        else ctrl.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await start({ fetchImpl: mockFetch(() => img(stream)) as typeof fetch });
    const res = await fetch(imageUrl(r, 'https://i.imgur.com/big.gif'));
    expect(res.status).toBe(200);
    let received = 0;
    await expect(
      (async () => {
        const reader = res.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          received += value.byteLength;
        }
      })(),
    ).rejects.toThrow();
    expect(received).toBeLessThanOrEqual(PROXY_MAX_IMAGE_BYTES);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(40);
  });

  it('follows redirects only to allow-listed hosts', async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.hostname === 'i.redd.it') {
        return new Response(null, { status: 301, headers: { location: 'https://i.imgur.com/b.png' } });
      }
      if (url.hostname === 'i.imgur.com' && url.pathname === '/b.png') return img(new Uint8Array([9]));
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/c.png' } });
    });
    const r = await start({ fetchImpl: fetchImpl as typeof fetch });
    const ok = await fetch(imageUrl(r, 'https://i.redd.it/a.png'));
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([9]));

    fetchImpl.mockClear();
    const bad = await fetch(imageUrl(r, 'https://i.imgur.com/other.png'));
    expect(bad.status).toBe(502);
    expect(await bad.json()).toEqual({ error: 'redirect-not-allowed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // evil host never contacted
  });

  it('refuses redirects to plain http', async () => {
    const fetchImpl = mockFetch(() => new Response(null, { status: 302, headers: { location: 'http://i.imgur.com/a.png' } }));
    const r = await start({ fetchImpl: fetchImpl as typeof fetch });
    expect((await fetch(imageUrl(r, 'https://i.imgur.com/a.png'))).status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
