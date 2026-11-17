import { MAX_MEME_BYTES, PROXY_IMAGE_HOSTS } from '@memes/shared';
import type { CaptionBox, ImageTools, MemeTemplate, ProcessedImage } from '../contracts';
import { MemeError } from './errors';
import { defaultBoxes, fitWithin, layoutCaption, memeFont, type CaptionLayout, type MeasureFn } from './layout';
import { fetchWithFallback, PRIVATE_FETCH_INIT, readCapped, type RouteMemory } from './net';
import { ALPHA_CAPABLE_MIMES, hasTransparentPixel, MEME_MIMES, sniffMime } from './sniff';

/** Biggest file we'll even try to decode for an upload (phone photos can be large; output is ≤ 1600px). */
export const MAX_UPLOAD_INPUT_BYTES = 64 * 1024 * 1024;
export const UPLOAD_QUALITY = 0.85;
export const RENDER_QUALITY = 0.9;

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

// ─── Platform seams (browser by default; injectable for tests) ──────────────

export interface DecodedImage {
  /** Display size, with EXIF orientation applied. */
  width: number;
  height: number;
  source: CanvasImageSource;
  close(): void;
}

export type Decoder = (blob: Blob) => Promise<DecodedImage>;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Surface {
  ctx: Ctx2D;
  width: number;
  height: number;
  toBlob(type: string, quality?: number): Promise<Blob>;
}

export type SurfaceFactory = (width: number, height: number) => Surface;

const decodeFailed = (cause: unknown) =>
  new MemeError('decode-failed', "This image couldn't be opened. Your browser may not support its format.", { cause });

/** createImageBitmap with EXIF orientation, falling back to <img>. */
export const browserDecode: Decoder = async (blob) => {
  let bitmapError: unknown;
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
    } catch (err) {
      bitmapError = err;
    }
  }
  if (typeof Image !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      // Modern browsers apply EXIF orientation to <img> (image-orientation: from-image).
      return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => URL.revokeObjectURL(url) };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw decodeFailed(err);
    }
  }
  if (bitmapError) throw decodeFailed(bitmapError);
  throw new MemeError('unsupported-environment', 'Images cannot be decoded in this environment.');
};

/** A 2D canvas: <canvas> on the main thread, OffscreenCanvas in workers. */
export const browserSurface: SurfaceFactory = (width, height) => {
  const noCtx = () => new MemeError('unsupported-environment', 'Canvas 2D is not available.');
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw noCtx();
    return {
      ctx,
      width,
      height,
      toBlob: (type, quality) =>
        new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new MemeError('unsupported-environment', 'Image encoding failed.'))), type, quality),
        ),
    };
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw noCtx();
    return { ctx, width, height, toBlob: (type, quality) => canvas.convertToBlob({ type, quality }) };
  }
  throw noCtx();
};

// ─── Encoding ───────────────────────────────────────────────────────────────

/**
 * Encode to WebP; if the browser silently ignores WebP (Safari returns PNG), use
 * PNG for images with transparency and JPEG otherwise. Pure apart from `encode`.
 */
export async function encodeWithFallback(
  encode: (type: string, quality?: number) => Promise<Blob>,
  opts: { quality: number; isTransparent: () => boolean },
): Promise<Blob> {
  const webp = await encode('image/webp', opts.quality);
  if (webp.type === 'image/webp') return webp;
  if (opts.isTransparent()) return webp.type === 'image/png' ? webp : encode('image/png');
  return encode('image/jpeg', opts.quality);
}

function surfaceIsTransparent(s: Surface): boolean {
  try {
    return hasTransparentPixel(s.ctx.getImageData(0, 0, s.width, s.height).data);
  } catch {
    return false;
  }
}

function drawCaption(ctx: Ctx2D, layout: CaptionLayout): void {
  ctx.save();
  ctx.font = memeFont(layout.fontPx);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = layout.strokePx;
  ctx.strokeStyle = layout.stroke;
  ctx.fillStyle = layout.fill;
  for (const line of layout.lines) {
    if (!line.text) continue;
    ctx.strokeText(line.text, line.x, line.y);
    ctx.fillText(line.text, line.x, line.y);
  }
  ctx.restore();
}

// ─── ImageTools ─────────────────────────────────────────────────────────────

export interface ImageToolsDeps {
  fetchImpl: typeof fetch;
  memory: RouteMemory;
  proxyUrl: (path: string) => string;
  decode?: Decoder;
  createSurface?: SurfaceFactory;
}

const PROXY_HOSTS: ReadonlySet<string> = new Set(PROXY_IMAGE_HOSTS);

/** Whether the relay's /proxy/image will accept this URL. */
export function isProxyableImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && PROXY_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function createImageTools(deps: ImageToolsDeps): ImageTools {
  const decode = deps.decode ?? browserDecode;
  const createSurface = deps.createSurface ?? browserSurface;

  async function decodeOrThrow(blob: Blob): Promise<DecodedImage> {
    try {
      return await decode(blob);
    } catch (err) {
      throw err instanceof MemeError ? err : decodeFailed(err);
    }
  }

  async function fetchImage(url: string): Promise<ProcessedImage> {
    let u: URL;
    try {
      u = new URL(url, globalThis.location?.href);
    } catch (err) {
      throw new MemeError('invalid-url', `Not a valid image URL: ${url}`, { cause: err });
    }
    if (!['http:', 'https:', 'blob:', 'data:'].includes(u.protocol)) {
      throw new MemeError('invalid-url', `Unsupported URL scheme: ${u.protocol}`);
    }
    // All allow-listed hosts serve HTTPS; avoid mixed-content failures.
    if (u.protocol === 'http:' && PROXY_HOSTS.has(u.hostname)) u.protocol = 'https:';
    const href = u.href;
    const { res } = await fetchWithFallback({
      fetchImpl: deps.fetchImpl,
      memory: deps.memory,
      key: `image:${u.protocol}//${u.host}`,
      directUrl: href,
      proxyUrl: isProxyableImageUrl(href) ? deps.proxyUrl(`/proxy/image?url=${encodeURIComponent(href)}`) : null,
      init: PRIVATE_FETCH_INIT,
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      const code = res.status === 403 || res.status === 429 ? 'rate-limited' : 'http';
      throw new MemeError(code, `Image download failed (HTTP ${res.status}).`, { status: res.status });
    }
    const bytes = await readCapped(res, MAX_MEME_BYTES);
    const mime = sniffMime(bytes);
    if (!mime || !MEME_MIMES.has(mime)) {
      throw new MemeError('unsupported-type', 'That link is not a supported image (JPEG, PNG, GIF, WebP or AVIF).');
    }
    const blob = new Blob([bytes], { type: mime });
    const img = await decodeOrThrow(blob);
    const { width, height } = img;
    img.close();
    return { blob, mime, width, height };
  }

  async function processUpload(file: Blob): Promise<ProcessedImage> {
    if (file.size > MAX_UPLOAD_INPUT_BYTES) {
      throw new MemeError('too-large', `That file is ${mb(file.size)} MB; the limit is ${mb(MAX_UPLOAD_INPUT_BYTES)} MB.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffMime(bytes);
    if (!mime) throw new MemeError('unsupported-type', 'Only image files (JPEG, PNG, GIF, WebP, HEIC…) can be shared.');

    if (mime === 'image/gif') {
      // GIFs keep their animation, so they're stored as-is.
      if (bytes.byteLength > MAX_MEME_BYTES) {
        throw new MemeError(
          'too-large',
          `GIFs are sent as-is and must be ${mb(MAX_MEME_BYTES)} MB or smaller; this one is ${mb(bytes.byteLength)} MB.`,
        );
      }
      const blob = new Blob([bytes], { type: 'image/gif' });
      const img = await decodeOrThrow(blob);
      const { width, height } = img;
      img.close();
      return { blob, mime: 'image/gif', width, height };
    }

    // Still images: decode (EXIF orientation applied), resize, re-encode.
    // Drawing to a canvas and re-encoding drops EXIF/GPS and every other metadata block.
    const img = await decodeOrThrow(new Blob([bytes], { type: mime }));
    let surface: Surface;
    let size: { width: number; height: number };
    try {
      size = fitWithin(img.width, img.height);
      surface = createSurface(size.width, size.height);
      surface.ctx.imageSmoothingEnabled = true;
      surface.ctx.imageSmoothingQuality = 'high';
      surface.ctx.drawImage(img.source, 0, 0, size.width, size.height);
    } finally {
      img.close();
    }
    const s = surface;
    const blob = await encodeWithFallback(s.toBlob, {
      quality: UPLOAD_QUALITY,
      isTransparent: () => ALPHA_CAPABLE_MIMES.has(mime) && surfaceIsTransparent(s),
    });
    if (blob.size > MAX_MEME_BYTES) {
      throw new MemeError('too-large', `The processed image is still ${mb(blob.size)} MB; the limit is ${mb(MAX_MEME_BYTES)} MB.`);
    }
    return { blob, mime: blob.type, width: size.width, height: size.height };
  }

  async function renderMeme(template: MemeTemplate, boxes: CaptionBox[]): Promise<ProcessedImage> {
    // Same bytes path as any remote image (direct → proxy), and decoding from a Blob
    // means the canvas is never tainted by a cross-origin image.
    const fetched = await fetchImage(template.url);
    const img = await decodeOrThrow(fetched.blob);
    let surface: Surface;
    let size: { width: number; height: number };
    try {
      size = fitWithin(img.width, img.height);
      surface = createSurface(size.width, size.height);
      const ctx = surface.ctx;
      ctx.fillStyle = '#ffffff'; // flatten transparent templates
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img.source, 0, 0, size.width, size.height);
    } finally {
      img.close();
    }
    const s = surface;
    const measure: MeasureFn = (text, px) => {
      s.ctx.font = memeFont(px);
      return s.ctx.measureText(text).width;
    };
    for (const box of boxes) {
      if (!box.text.trim()) continue;
      drawCaption(s.ctx, layoutCaption(box, size.width, size.height, measure));
    }
    const blob = await encodeWithFallback(s.toBlob, { quality: RENDER_QUALITY, isTransparent: () => false });
    return { blob, mime: blob.type, width: size.width, height: size.height };
  }

  return { fetchImage, processUpload, renderMeme, defaultBoxes };
}
