import jsQR from 'jsqr';

/**
 * Pure jsQR decoding on RGBA pixel buffers (no DOM), shared by the camera loop, the
 * photo scanner and the Node unit tests. Imported lazily in the browser so jsQR is only
 * downloaded when someone actually scans.
 */

export interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Scale (w, h) down so the longer side is at most `maxDim` (never up). */
export function fitWithin(width: number, height: number, maxDim: number): Size {
  const k = Math.min(1, maxDim / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Box-filter downscale so the longer side is at most `maxDim`. Returns `img` itself if it already fits. */
export function downscale(img: Rgba, maxDim: number): Rgba {
  const { width: w, height: h } = fitWithin(img.width, img.height, maxDim);
  if (w === img.width && h === img.height) return img;
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** One jsQR pass, trying normal and inverted (light-on-dark) colours. */
export function jsqrDecode(img: Rgba): string | null {
  const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return found && found.data !== '' ? found.data : null;
}

/** Sizes tried for a still image: a quick downscaled pass first, then full resolution. */
export const STILL_SIZES = [1024, Infinity] as const;

/** Decode a still image (photo/screenshot) at each size in turn; first hit wins. */
export function decodeStill(img: Rgba, sizes: readonly number[] = STILL_SIZES): string | null {
  let last: Rgba | null = null;
  for (const max of sizes) {
    const scaled = downscale(img, max);
    if (last && scaled.width === last.width && scaled.height === last.height) continue;
    last = scaled;
    const v = jsqrDecode(scaled);
    if (v) return v;
  }
  return null;
}
