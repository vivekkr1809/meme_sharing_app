import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/imgflip-get-memes.json';
import { createImgflipSource, IMGFLIP_GET_MEMES_URL, parseImgflipTemplates } from './imgflip';
import { makeProxyUrl, RouteMemory } from './net';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makeSource(fetchImpl: typeof fetch) {
  return createImgflipSource({ fetchImpl, memory: new RouteMemory(), proxyUrl: makeProxyUrl(() => 'http://localhost:8787') });
}

describe('parseImgflipTemplates', () => {
  it('maps get_memes to MemeTemplates and drops malformed/duplicate entries', () => {
    const t = parseImgflipTemplates(fixture);
    expect(t.map((x) => x.id)).toEqual(['181913649', '87743020', '112126428', '93895088', '438680']);
    expect(t[1]).toEqual({
      id: '87743020',
      name: 'Two Buttons',
      url: 'https://i.imgflip.com/1g8my4.jpg',
      width: 600,
      height: 908,
      boxCount: 3,
    });
  });

  it('rejects unsuccessful responses', () => {
    expect(() => parseImgflipTemplates({ success: false, error_message: 'nope' })).toThrow(/nope/);
    expect(() => parseImgflipTemplates({ success: true, data: {} })).toThrow(/no templates/);
  });
});

describe('ImgflipSource.listTemplates', () => {
  it('fetches directly once and memoizes for the session', async () => {
    const fetchImpl = vi.fn(async () => json(fixture));
    const src = makeSource(fetchImpl);
    const [a, b] = await Promise.all([src.listTemplates(), src.listTemplates()]);
    const c = await src.listTemplates();
    expect(a).toHaveLength(5);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(IMGFLIP_GET_MEMES_URL);
  });

  it('falls back to the proxy', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url === IMGFLIP_GET_MEMES_URL) throw new TypeError('CORS');
      return json(fixture);
    }) as unknown as typeof fetch;
    expect(await makeSource(fetchImpl).listTemplates()).toHaveLength(5);
    expect(calls).toEqual([IMGFLIP_GET_MEMES_URL, 'http://localhost:8787/proxy/imgflip/get_memes']);
  });

  it('does not memoize failures', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? json({ oops: true }, 502) : json(fixture)));
    const src = makeSource(fetchImpl);
    await expect(src.listTemplates()).rejects.toMatchObject({ code: 'http', status: 502 });
    expect(await src.listTemplates()).toHaveLength(5);
  });

  it('never calls caption_image', async () => {
    const fetchImpl = vi.fn(async () => json(fixture));
    await makeSource(fetchImpl).listTemplates();
    for (const [url] of fetchImpl.mock.calls as unknown as [string][]) expect(url).not.toMatch(/caption_image/);
  });
});
