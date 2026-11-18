import { fitWithin } from './decode';

/**
 * QR detection on video frames, bitmaps and canvases.
 *
 * Uses the native BarcodeDetector when the browser has one that reads QR codes (Android
 * Chrome, recent Safari), and jsQR on canvas pixels otherwise (desktop Chrome on Linux and
 * Windows, Firefox, older Safari). A native detector that fails at runtime is swapped for
 * jsQR for the rest of the session.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Region {
  /** Part of the source to look at, in source pixels. Default: all of it. */
  crop?: Rect;
  /** Longest side the region is scaled down to before decoding (jsQR, or native with a crop). */
  maxDim?: number;
}

export type DetectorKind = 'native' | 'jsqr';

export interface QrDetector {
  readonly kind: DetectorKind;
  /** Every QR value found in `source`, which is `width`×`height` pixels. */
  detect(source: CanvasImageSource, width: number, height: number, region?: Region): Promise<string[]>;
}

interface NativeBarcodeDetector {
  detect(source: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string }[]>;
}
interface NativeBarcodeDetectorCtor {
  new (opts: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

/** The global BarcodeDetector, if it supports QR codes. */
export async function nativeQrSupport(scope: object = globalThis): Promise<NativeBarcodeDetectorCtor | null> {
  const Ctor = (scope as { BarcodeDetector?: NativeBarcodeDetectorCtor }).BarcodeDetector;
  if (typeof Ctor !== 'function') return null;
  try {
    if (Ctor.getSupportedFormats) {
      const formats = await Ctor.getSupportedFormats();
      if (!formats.includes('qr_code')) return null;
    }
    return Ctor;
  } catch {
    return null;
  }
}

/** Centre square covering `frac` of the shorter side: makes small or distant codes bigger for jsQR. */
export function centerCrop(width: number, height: number, frac = 0.6): Rect {
  const side = Math.round(Math.min(width, height) * frac);
  return { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), w: side, h: side };
}

/**
 * What to look at on camera frame number `n`. Native detectors get the whole frame. jsQR
 * alternates between the whole frame (scaled to ≤ 640 px) and a sharper centre crop.
 */
export function cameraRegion(kind: DetectorKind, width: number, height: number, n: number): Region {
  if (kind === 'native') return {};
  return n % 2 === 0 ? { maxDim: 640 } : { crop: centerCrop(width, height), maxDim: 720 };
}

type Ctx = CanvasRenderingContext2D;

function makeCanvas(): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('unsupported-environment');
  return { canvas, ctx };
}

/** Draw `region` of `source` onto `canvas`, scaled to fit `maxDim`. */
function drawRegion(c: { canvas: HTMLCanvasElement; ctx: Ctx }, source: CanvasImageSource, width: number, height: number, region: Region) {
  const crop = region.crop ?? { x: 0, y: 0, w: width, h: height };
  const out = fitWithin(crop.w, crop.h, region.maxDim ?? Infinity);
  if (c.canvas.width !== out.width) c.canvas.width = out.width;
  if (c.canvas.height !== out.height) c.canvas.height = out.height;
  c.ctx.imageSmoothingEnabled = true;
  c.ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
  return out;
}

export function createJsqrDetector(): QrDetector {
  let c: { canvas: HTMLCanvasElement; ctx: Ctx } | null = null;
  return {
    kind: 'jsqr',
    async detect(source, width, height, region = {}) {
      const { jsqrDecode } = await import('./decode');
      c ??= makeCanvas();
      const out = drawRegion(c, source, width, height, region);
      const img = c.ctx.getImageData(0, 0, out.width, out.height);
      const v = jsqrDecode(img);
      return v ? [v] : [];
    },
  };
}

export function createNativeDetector(Ctor: NativeBarcodeDetectorCtor): QrDetector {
  const bd = new Ctor({ formats: ['qr_code'] });
  let c: { canvas: HTMLCanvasElement; ctx: Ctx } | null = null;
  return {
    kind: 'native',
    async detect(source, width, height, region = {}) {
      let target: CanvasImageSource = source;
      if (region.crop || (region.maxDim && Math.max(width, height) > region.maxDim)) {
        c ??= makeCanvas();
        drawRegion(c, source, width, height, region);
        target = c.canvas;
      }
      const found = await bd.detect(target);
      return found.map((b) => b.rawValue).filter((v) => typeof v === 'string' && v !== '');
    },
  };
}

/** Native first; if it ever throws, fall back to jsQR for good. */
export async function createQrDetector(scope: object = globalThis): Promise<QrDetector> {
  const Ctor = await nativeQrSupport(scope);
  if (!Ctor) return createJsqrDetector();
  let native: QrDetector;
  try {
    native = createNativeDetector(Ctor);
  } catch {
    return createJsqrDetector();
  }
  let fallback: QrDetector | null = null;
  return {
    get kind() {
      return fallback ? fallback.kind : native.kind;
    },
    async detect(source, width, height, region) {
      if (!fallback) {
        try {
          return await native.detect(source, width, height, region);
        } catch {
          fallback = createJsqrDetector();
        }
      }
      return fallback.detect(source, width, height, region);
    },
  };
}
