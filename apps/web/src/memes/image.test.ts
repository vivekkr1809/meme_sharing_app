import { MAX_MEME_BYTES } from '@memes/shared';
import { describe, expect, it, vi } from 'vitest';
import { createImageTools, encodeWithFallback, isProxyableImageUrl, type Decoder } from './image';
import { makeProxyUrl, RouteMemory } from './net';
import { containsExif, hasTransparentPixel, sniffMime } from './sniff';

const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? enc(p) : p)));

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], 'JFIF', [0, 1, 1]);
const PNG = bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR');
const GIF = bytes('GIF89a', [10, 0, 20, 0, 0, 0, 0], ';');
const WEBP = bytes('RIFF', [26, 0, 0, 0], 'WEBPVP8 ');
const AVIF = bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0]);
const HEIC = bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0]);
const HTML = bytes('<!doctype html><html>');

describe('sniffMime', () => {
  it.each([
    [JPEG, 'image/jpeg'],
    [PNG, 'image/png'],
    [GIF, 'image/gif'],
    [bytes('GIF87a', [1, 0, 1, 0]), 'image/gif'],
    [WEBP, 'image/webp'],
    [AVIF, 'image/avif'],
    [HEIC, 'image/heic'],
    [bytes('BM', [0, 0, 0, 0]), 'image/bmp'],
    [HTML, null],
    [bytes('<svg xmlns="http://www.w3.org/2000/svg">'), null],
    [new Uint8Array(), null],
    [bytes([0xff, 0xd8]), null],
    [bytes('RIFF', [0, 0, 0, 0], 'WAVE'), null],
  ])('%#', (input, expected) => {
    expect(sniffMime(input)).toBe(expected);
  });

  it('containsExif finds the APP1 marker', () => {
    expect(containsExif(bytes([0xff, 0xd8, 0xff, 0xe1, 0, 8], 'Exif', [0, 0]))).toBe(true);
    expect(containsExif(JPEG)).toBe(false);
  });

  it('hasTransparentPixel', () => {
    expect(hasTransparentPixel([0, 0, 0, 255, 9, 9, 9, 255])).toBe(false);
    expect(hasTransparentPixel([0, 0, 0, 255, 9, 9, 9, 254])).toBe(true);
  });
});

describe('encodeWithFallback', () => {
  const blob = (type: string) => new Blob(['x'], { type });

  it('uses WebP when supported', async () => {
    const encode = vi.fn(async (type: string) => blob(type));
    const out = await encodeWithFallback(encode, { quality: 0.85, isTransparent: () => true });
    expect(out.type).toBe('image/webp');
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledWith('image/webp', 0.85);
  });

  it('falls back to JPEG at the same quality when WebP is ignored (Safari returns PNG)', async () => {
    const encode = vi.fn(async (type: string) => blob(type === 'image/jpeg' ? 'image/jpeg' : 'image/png'));
    const out = await encodeWithFallback(encode, { quality: 0.85, isTransparent: () => false });
    expect(out.type).toBe('image/jpeg');
    expect(encode).toHaveBeenLastCalledWith('image/jpeg', 0.85);
  });

  it('keeps transparency as PNG, reusing the PNG the browser already produced', async () => {
    const encode = vi.fn(async () => blob('image/png'));
    const out = await encodeWithFallback(encode, { quality: 0.85, isTransparent: () => true });
    expect(out.type).toBe('image/png');
    expect(encode).toHaveBeenCalledTimes(1);
  });
});

describe('isProxyableImageUrl', () => {
  it('only allows PROXY_IMAGE_HOSTS over http(s)', () => {
    expect(isProxyableImageUrl('https://i.redd.it/a.jpg')).toBe(true);
    expect(isProxyableImageUrl('https://preview.redd.it/a.jpg?width=640')).toBe(true);
    expect(isProxyableImageUrl('https://i.imgflip.com/1.jpg')).toBe(true);
    expect(isProxyableImageUrl('https://evil.example.com/i.redd.it.jpg')).toBe(false);
    expect(isProxyableImageUrl('https://i.redd.it.evil.com/a.jpg')).toBe(false);
    expect(isProxyableImageUrl('ftp://i.redd.it/a.jpg')).toBe(false);
    expect(isProxyableImageUrl('nonsense')).toBe(false);
  });
});

/** Node has no image decoder: pretend every image is 640x480. */
const fakeDecode: Decoder = async () => ({ width: 640, height: 480, source: {} as CanvasImageSource, close() {} });

function tools(fetchImpl: typeof fetch, decode: Decoder = fakeDecode) {
  return createImageTools({
    fetchImpl,
    memory: new RouteMemory(),
    proxyUrl: makeProxyUrl(() => 'https://relay.example.com'),
    decode,
    createSurface: () => {
      throw new Error('no canvas in node');
    },
  });
}

describe('ImageTools.fetchImage (mocked network)', () => {
  it('sniffs the mime from bytes, ignoring Content-Type', async () => {
    const fetchImpl = vi.fn(async () => new Response(PNG, { headers: { 'content-type': 'image/jpeg' } }));
    const img = await tools(fetchImpl).fetchImage('https://i.redd.it/x.jpg');
    expect(img).toMatchObject({ mime: 'image/png', width: 640, height: 480 });
    expect(img.blob.type).toBe('image/png');
    expect(img.blob.size).toBe(PNG.byteLength);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('falls back to /proxy/image for allow-listed hosts and remembers per host', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://i.redd.it/')) throw new TypeError('CORS');
      return new Response(JPEG);
    }) as unknown as typeof fetch;
    const t = tools(fetchImpl);
    await t.fetchImage('https://i.redd.it/a.jpg');
    await t.fetchImage('https://i.redd.it/b.jpg');
    await t.fetchImage('https://i.imgur.com/c.png');
    expect(calls).toEqual([
      'https://i.redd.it/a.jpg',
      'https://relay.example.com/proxy/image?url=https%3A%2F%2Fi.redd.it%2Fa.jpg',
      'https://relay.example.com/proxy/image?url=https%3A%2F%2Fi.redd.it%2Fb.jpg',
      'https://i.imgur.com/c.png',
    ]);
  });

  it('upgrades http to https for allow-listed hosts', async () => {
    const fetchImpl = vi.fn(async () => new Response(JPEG));
    await tools(fetchImpl).fetchImage('http://i.imgur.com/c.jpg');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://i.imgur.com/c.jpg');
  });

  it('never proxies non-allow-listed hosts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('CORS');
    });
    await expect(tools(fetchImpl).fetchImage('https://example.com/a.jpg')).rejects.toMatchObject({ code: 'network' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces MAX_MEME_BYTES', async () => {
    const big = new Uint8Array(MAX_MEME_BYTES + 1);
    big.set(JPEG);
    const fetchImpl = vi.fn(async () => new Response(big));
    await expect(tools(fetchImpl).fetchImage('https://i.redd.it/big.jpg')).rejects.toMatchObject({ code: 'too-large' });
  });

  it('rejects non-images (e.g. an HTML "removed" page)', async () => {
    const fetchImpl = vi.fn(async () => new Response(HTML, { headers: { 'content-type': 'image/png' } }));
    await expect(tools(fetchImpl).fetchImage('https://i.imgur.com/removed.png')).rejects.toMatchObject({ code: 'unsupported-type' });
  });

  it('maps HTTP errors and bad URLs', async () => {
    await expect(tools(async () => new Response('', { status: 404 })).fetchImage('https://i.redd.it/gone.jpg')).rejects.toMatchObject({
      code: 'http',
      status: 404,
    });
    await expect(tools(async () => new Response(JPEG)).fetchImage('javascript:alert(1)')).rejects.toMatchObject({ code: 'invalid-url' });
    await expect(tools(async () => new Response(JPEG)).fetchImage('http://[bad')).rejects.toMatchObject({ code: 'invalid-url' });
  });

  it('surfaces decode failures', async () => {
    const decode: Decoder = async () => {
      throw new Error('bad image');
    };
    await expect(tools(async () => new Response(JPEG), decode).fetchImage('https://i.redd.it/x.jpg')).rejects.toMatchObject({
      code: 'decode-failed',
    });
  });
});

describe('ImageTools.processUpload (node-testable paths)', () => {
  const noFetch = (async () => {
    throw new Error('no network');
  }) as unknown as typeof fetch;

  it('passes GIFs through byte-for-byte', async () => {
    const out = await tools(noFetch).processUpload(new Blob([GIF], { type: 'application/octet-stream' }));
    expect(out.mime).toBe('image/gif');
    expect(new Uint8Array(await out.blob.arrayBuffer())).toEqual(GIF);
  });

  it('rejects GIFs over 15 MB with a clear message', async () => {
    const big = new Uint8Array(MAX_MEME_BYTES + 1);
    big.set(GIF);
    const err = await tools(noFetch)
      .processUpload(new Blob([big]))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'too-large' });
    expect((err as Error).message).toMatch(/GIFs .* 15\.0 MB or smaller/);
  });

  it('rejects files that are not images, whatever their declared type', async () => {
    await expect(tools(noFetch).processUpload(new Blob([HTML], { type: 'image/png' }))).rejects.toMatchObject({
      code: 'unsupported-type',
    });
  });

  it('rejects undecodable formats with decode-failed', async () => {
    const decode: Decoder = async () => {
      throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
    };
    await expect(tools(noFetch, decode).processUpload(new Blob([HEIC]))).rejects.toMatchObject({ code: 'decode-failed' });
  });
});
