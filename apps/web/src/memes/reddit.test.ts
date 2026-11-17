import { describe, expect, it, vi } from 'vitest';
import listing from './fixtures/reddit-listing.json';
import { isMemeError, MemeError } from './errors';
import { makeProxyUrl, RouteMemory } from './net';
import { createRedditSource, parseRedditListing, pickThumb, redditListingPath } from './reddit';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function makeSource(fetchImpl: typeof fetch, relay = 'https://relay.example.com') {
  return createRedditSource({ fetchImpl, memory: new RouteMemory(), proxyUrl: makeProxyUrl(() => relay) });
}

describe('parseRedditListing', () => {
  const page = parseRedditListing(listing);
  const byId = new Map(page.posts.map((p) => [p.id, p]));

  it('keeps only image posts, in order, deduped', () => {
    expect(page.posts.map((p) => p.id)).toEqual([
      '1gxa001', // i.redd.it jpeg (duplicate entry dropped)
      '1gxb002', // gallery
      '1gxb003', // gallery: failed item skipped, animated gif used
      '1gxe007', // nsfw
      '1gxe008', // spoiler
      '1gxf009', // i.imgur.com png
      '1gxh013', // i.redd.it gif
      '1gxi014', // post_hint image on another host
      '1gxj015', // crosspost
    ]);
    expect(page.after).toBe('t3_1gxq0zz');
  });

  it('skips self posts, videos, gifv, links, mp4-only galleries, removed posts and junk', () => {
    for (const id of ['1gxmod1', '1gxb004', '1gxc005', '1gxd006', '1gxf010', '1gxf011', '1gxg012', '1gxk016']) {
      expect(byId.has(id)).toBe(false);
    }
  });

  it('maps a plain image post', () => {
    expect(byId.get('1gxa001')).toEqual({
      id: '1gxa001',
      title: 'When the code works on the first try',
      subreddit: 'memes',
      author: 'pixel_pusher',
      score: 48211,
      permalink: 'https://www.reddit.com/r/memes/comments/1gxa001/when_the_code_works_on_the_first_try/',
      imageUrl: 'https://i.redd.it/abc123first.jpeg',
      thumbUrl: 'https://preview.redd.it/abc123first.jpeg?width=640&crop=smart&auto=webp&s=d',
      width: 1200,
      height: 1500,
      nsfw: false,
      createdAt: 1731812345000,
    });
  });

  it('uses the first gallery image (gallery order) at its i.redd.it original', () => {
    const p = byId.get('1gxb002')!;
    expect(p.imageUrl).toBe('https://i.redd.it/galsecond.jpg');
    expect(p.thumbUrl).toBe('https://preview.redd.it/galsecond.jpg?width=640&crop=smart&auto=webp&s=14');
    expect([p.width, p.height]).toEqual([1080, 1350]);
    const anim = byId.get('1gxb003')!;
    expect(anim.imageUrl).toBe('https://i.redd.it/anim1.gif');
    expect([anim.width, anim.height]).toEqual([800, 600]);
  });

  it('flags over_18 and spoiler posts (including a spoiler crosspost parent) as nsfw', () => {
    expect(byId.get('1gxe007')!.nsfw).toBe(true);
    expect(byId.get('1gxe008')!.nsfw).toBe(true);
    expect(byId.get('1gxj015')!.nsfw).toBe(true);
    expect(byId.get('1gxj015')!.imageUrl).toBe('https://i.redd.it/xpostparent.jpg');
    expect(byId.get('1gxf009')!.nsfw).toBe(false);
  });

  it('unescapes &amp; and picks the preview closest to 640px (source included)', () => {
    const p = byId.get('1gxe007')!;
    expect(p.thumbUrl).toBe('https://preview.redd.it/nsfw007.png?auto=webp&s=src7');
    expect(byId.get('1gxh013')!.thumbUrl).toBe('https://preview.redd.it/dance013.gif?format=png8&s=src13');
    expect(byId.get('1gxf009')!.thumbUrl).toBeUndefined();
  });

  it('dedupes by image URL as well as id', () => {
    const child = listing.data.children[1]!;
    const dup = { kind: 't3', data: { ...child.data, id: 'other', name: 't3_other' } };
    const page2 = parseRedditListing({ kind: 'Listing', data: { after: null, children: [child, dup] } });
    expect(page2.posts.map((p) => p.id)).toEqual(['1gxa001']);
    expect(page2.after).toBeNull();
  });

  it('throws bad-response on non-listings', () => {
    expect(() => parseRedditListing({ error: 500 })).toThrow(MemeError);
    expect(() => parseRedditListing(null)).toThrow(/unexpected/);
  });

  it('pickThumb prefers the width nearest 640', () => {
    expect(pickThumb([{ url: 'a', width: 320 }, { url: 'b', width: 960 }, { url: 'c', width: 700 }])?.url).toBe('c');
    expect(pickThumb([])).toBeUndefined();
  });
});

describe('RedditSource.fetchPage', () => {
  it('builds the direct URL with raw_json, limit and after', async () => {
    const fetchImpl = vi.fn(async () => json(listing));
    const page = await makeSource(fetchImpl).fetchPage('memes', { sort: 'new', after: 't3_abc' });
    expect(page.posts.length).toBe(9);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.reddit.com/r/memes/new.json?raw_json=1&limit=25&after=t3_abc');
    expect(init.credentials).toBe('omit');
    expect(redditListingPath('memes', 'hot')).toBe('/r/memes/hot.json?raw_json=1&limit=25');
  });

  it('accepts "r/name" input and defaults to hot', async () => {
    const fetchImpl = vi.fn(async () => json(listing));
    await makeSource(fetchImpl).fetchPage('r/me_irl');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://www.reddit.com/r/me_irl/hot.json?raw_json=1&limit=25');
  });

  it('rejects invalid subreddit names and sorts without fetching', async () => {
    const fetchImpl = vi.fn(async () => json(listing));
    const src = makeSource(fetchImpl);
    for (const bad of ['', 'a', 'has space', '../etc', 'x'.repeat(33), 'semi;colon']) {
      await expect(src.fetchPage(bad)).rejects.toMatchObject({ code: 'invalid-subreddit' });
    }
    await expect(src.fetchPage('memes', { sort: 'controversial' as never })).rejects.toMatchObject({ code: 'invalid-subreddit' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the relay proxy on a CORS/network error and remembers it', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).startsWith('https://www.reddit.com/')) throw new TypeError('Failed to fetch');
      return json(listing);
    }) as unknown as typeof fetch;
    const src = makeSource(fetchImpl);
    await src.fetchPage('memes');
    await src.fetchPage('memes', { after: 't3_1gxq0zz' });
    expect(calls).toEqual([
      'https://www.reddit.com/r/memes/hot.json?raw_json=1&limit=25',
      'https://relay.example.com/proxy/reddit/r/memes/hot.json?raw_json=1&limit=25',
      // Second page goes straight to the proxy.
      'https://relay.example.com/proxy/reddit/r/memes/hot.json?raw_json=1&limit=25&after=t3_1gxq0zz',
    ]);
  });

  it.each([403, 429])('falls back on HTTP %i from Reddit', async (status) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return url.includes('/proxy/') ? json(listing) : new Response('<html>blocked</html>', { status });
    }) as unknown as typeof fetch;
    const page = await makeSource(fetchImpl).fetchPage('memes');
    expect(page.posts.length).toBe(9);
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('/proxy/reddit/r/memes/hot.json');
  });

  it('uses a same-origin relative proxy path when the relay URL is empty', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (!url.startsWith('/')) throw new TypeError('Failed to fetch');
      return json(listing);
    }) as unknown as typeof fetch;
    await makeSource(fetchImpl, '').fetchPage('memes');
    expect(calls[1]).toBe('/proxy/reddit/r/memes/hot.json?raw_json=1&limit=25');
  });

  it('throws network when both routes fail', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(makeSource(fetchImpl).fetchPage('memes')).rejects.toMatchObject({ code: 'network' });
  });

  it('reports a missing subreddit (404) without trying the proxy', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'Not Found', error: 404 }, { status: 404 }));
    const err = await makeSource(fetchImpl).fetchPage('doesnotexist123').catch((e: unknown) => e);
    expect(isMemeError(err, 'subreddit-unavailable')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a private subreddit (403 with reason on both routes)', async () => {
    const fetchImpl = vi.fn(async () => json({ reason: 'private', message: 'Forbidden', error: 403 }, { status: 403 }));
    const err = await makeSource(fetchImpl).fetchPage('secretclub').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'subreddit-unavailable', reason: 'private', status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a bare 403 on every route as blocking, not a missing sub', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>whoa there</html>', { status: 403 }));
    await expect(makeSource(fetchImpl).fetchPage('memes')).rejects.toMatchObject({ code: 'rate-limited' });
  });

  it('detects the redirect to subreddit search', async () => {
    const search = { kind: 'Listing', data: { after: null, children: [{ kind: 't5', data: { display_name: 'nope' } }] } };
    const fetchImpl = vi.fn(async () => json(search));
    await expect(makeSource(fetchImpl).fetchPage('nope')).rejects.toMatchObject({ code: 'subreddit-unavailable' });
  });

  it('maps other failures', async () => {
    await expect(makeSource(async () => new Response('oops', { status: 500 })).fetchPage('memes')).rejects.toMatchObject({
      code: 'http',
      status: 500,
    });
    await expect(makeSource(async () => new Response('not json')).fetchPage('memes')).rejects.toMatchObject({
      code: 'bad-response',
    });
  });
});
