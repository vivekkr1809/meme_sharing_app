import { pickPairingCode } from './code';
import { STILL_SIZES } from './decode';
import { createQrDetector, type QrDetector } from './detector';

/**
 * Reading a QR code from a photo or screenshot (remote pairing). Same detector as the
 * camera; tries a quick downscaled pass, then full resolution (capped, so a 50 MP photo
 * doesn't exhaust memory on a phone).
 */

/** Longest side we ever decode at. Big enough for a QR that is a small part of a screenshot. */
export const MAX_STILL_DIM = 3000;

interface Still {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function loadStill(file: Blob): Promise<Still> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* e.g. HEIC on a browser without the codec: try an <img>, which may know more formats */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Every QR value found in the image (empty if none). Throws 'decode-failed' if it isn't a readable image. */
export async function scanImageFile(file: Blob, detector?: QrDetector): Promise<string[]> {
  let still: Still;
  try {
    still = await loadStill(file);
  } catch {
    throw new Error('decode-failed');
  }
  try {
    const d = detector ?? (await createQrDetector());
    const seen: string[] = [];
    const sizes = d.kind === 'native' ? [Infinity, 1024] : STILL_SIZES;
    for (const max of sizes) {
      const values = await d.detect(still.source, still.width, still.height, { maxDim: Math.min(max, MAX_STILL_DIM) }).catch(() => []);
      for (const v of values) if (!seen.includes(v)) seen.push(v);
      if (pickPairingCode(seen).code) break;
    }
    return seen;
  } finally {
    still.close();
  }
}
