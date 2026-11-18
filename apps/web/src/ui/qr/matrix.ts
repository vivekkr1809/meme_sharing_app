import QRCode from 'qrcode';

/**
 * QR symbol generation and rasterising, without the DOM. Used for the "Save QR image"
 * PNG and by the tests (unit and E2E) to produce scannable codes.
 */

/** Error correction 'M' (15 %): survives glare and a bit of blur while keeping the symbol small. */
export const QR_EC = 'M' as const;
/** The quiet zone the QR spec asks for, in modules. */
export const QUIET_ZONE = 4;

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number;
  /** Row-major, 1 = dark. */
  dark: (row: number, col: number) => boolean;
}

export function qrMatrix(text: string): QrMatrix {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: QR_EC });
  return { size: modules.size, dark: (r, c) => modules.get(r, c) === 1 };
}

export interface RasterOptions {
  /** Pixels per module (may be fractional; nearest-neighbour sampling). Default 8. */
  scale?: number;
  /** Quiet zone in modules. Default QUIET_ZONE. */
  margin?: number;
  /** Light modules on dark background. */
  invert?: boolean;
  /** Grey levels for dark / light modules. Default 0 / 255. */
  darkLevel?: number;
  lightLevel?: number;
}

/** Rasterise to an RGBA buffer of side round((size + 2·margin)·scale). */
export function rasterize(m: QrMatrix, opts: RasterOptions = {}): { data: Uint8ClampedArray; width: number; height: number } {
  const scale = opts.scale ?? 8;
  const margin = opts.margin ?? QUIET_ZONE;
  let dark = opts.darkLevel ?? 0;
  let light = opts.lightLevel ?? 255;
  if (opts.invert) [dark, light] = [light, dark];
  const total = m.size + 2 * margin;
  const side = Math.round(total * scale);
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    const row = Math.floor(y / scale) - margin;
    for (let x = 0; x < side; x++) {
      const col = Math.floor(x / scale) - margin;
      const on = row >= 0 && col >= 0 && row < m.size && col < m.size && m.dark(row, col);
      const v = on ? dark : light;
      const o = (y * side + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width: side, height: side };
}
