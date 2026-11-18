/**
 * Browser test harness for src/memes (driven by ../browser.test.ts through Playwright).
 * Exposes the real MemeServices plus helpers on `window.memeHarness`. Not part of the app bundle.
 */
import type { ProcessedImage } from '../../contracts';
import { createMemeServices } from '../index';
import { containsExif, sniffMime } from '../sniff';

const relay = new URLSearchParams(location.search).get('relay') ?? location.origin;
const services = createMemeServices({ getRelayUrl: () => relay });

/** A 1x1 GIF89a. */
const TINY_GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0));

/** APP1 segment holding a minimal big-endian EXIF IFD0 with a single Orientation tag. */
function exifSegment(orientation: number): Uint8Array {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, IFD0 at offset 8
    0x00, 0x01, // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation SHORT
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality));
}

/** A w×h JPEG with an EXIF APP1 segment (Orientation = `orientation`) right after SOI. */
async function makeJpegWithExif(w: number, h: number, orientation: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#f80');
  g.addColorStop(1, '#08f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const jpeg = new Uint8Array(await (await canvasBlob(c, 'image/jpeg', 0.9)).arrayBuffer());
  const exif = exifSegment(orientation);
  const out = new Uint8Array(jpeg.length + exif.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(exif, 2);
  out.set(jpeg.subarray(2), 2 + exif.length);
  return new Blob([out], { type: 'image/jpeg' });
}

/** A w×h PNG whose left half is transparent. */
async function makeTransparentPng(w: number, h: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0a0';
  ctx.fillRect(w / 2, 0, w / 2, h);
  return canvasBlob(c, 'image/png');
}

export interface ImageSummary {
  mime: string;
  blobType: string;
  width: number;
  height: number;
  size: number;
  sniffed: string | null;
  exif: boolean;
  decodedWidth: number;
  decodedHeight: number;
}

async function summarize(img: ProcessedImage): Promise<ImageSummary> {
  const bytes = new Uint8Array(await img.blob.arrayBuffer());
  // Decode independently of the code under test.
  const bmp = await createImageBitmap(img.blob);
  const summary = {
    mime: img.mime,
    blobType: img.blob.type,
    width: img.width,
    height: img.height,
    size: bytes.byteLength,
    sniffed: sniffMime(bytes),
    exif: containsExif(bytes),
    decodedWidth: bmp.width,
    decodedHeight: bmp.height,
  };
  bmp.close();
  return summary;
}

/** RGBA of one pixel of an image blob. */
async function pixelAt(blob: Blob, x: number, y: number): Promise<number[]> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

/** Fraction of near-white and near-black pixels in a region (captions are white with black outline). */
async function captionInk(blob: Blob, region: { x: number; y: number; w: number; h: number }): Promise<{ white: number; black: number }> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(region.x, region.y, region.w, region.h).data;
  let white = 0;
  let black = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
    if (r > 235 && g > 235 && b > 235) white++;
    if (r < 25 && g < 25 && b < 25) black++;
  }
  const n = d.length / 4;
  return { white: white / n, black: black / n };
}

const harness = {
  services,
  summarize,
  pixelAt,
  captionInk,
  makeJpegWithExif,
  makeTransparentPng,
  tinyGif: () => new Blob([TINY_GIF], { type: 'image/gif' }),
  tinyGifBytes: () => Array.from(TINY_GIF),
  bytesOf: async (b: Blob) => Array.from(new Uint8Array(await b.arrayBuffer())),
  containsExif: async (b: Blob) => containsExif(new Uint8Array(await b.arrayBuffer())),
};

declare global {
  interface Window {
    memeHarness: typeof harness;
  }
}

window.memeHarness = harness;
document.getElementById('status')!.textContent = 'ready';
