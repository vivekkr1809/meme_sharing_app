import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { QUIET_ZONE, qrMatrix } from '../../apps/web/src/ui/qr/matrix';

/**
 * QR fixtures generated in-process from the app's own QR matrix code (the `qrcode` lib):
 * a YUV4MPEG2 clip for Chromium's fake camera, and PNG "screenshots". No ffmpeg, no files
 * checked in.
 */

/** Greyscale canvas (one byte per pixel) with the QR for `text` at (x, y). */
function grey(text: string, width: number, height: number, opts: { scale: number; x?: number; y?: number; bg?: number }): Uint8Array {
  const m = qrMatrix(text);
  const side = (m.size + 2 * QUIET_ZONE) * opts.scale;
  const x0 = opts.x ?? Math.floor((width - side) / 2);
  const y0 = opts.y ?? Math.floor((height - side) / 2);
  if (x0 < 0 || y0 < 0 || x0 + side > width || y0 + side > height) throw new Error('QR does not fit');
  const px = new Uint8Array(width * height).fill(opts.bg ?? 255);
  for (let y = 0; y < side; y++) {
    const r = Math.floor(y / opts.scale) - QUIET_ZONE;
    for (let x = 0; x < side; x++) {
      const c = Math.floor(x / opts.scale) - QUIET_ZONE;
      const dark = r >= 0 && c >= 0 && r < m.size && c < m.size && m.dark(r, c);
      px[(y0 + y) * width + x0 + x] = dark ? 0 : 255;
    }
  }
  return px;
}

/**
 * A YUV4MPEG2 (C420) clip: white background, the QR centred, a few identical frames.
 * Y plane = the picture; U and V are a constant 128 (no colour).
 */
export function qrY4m(text: string, opts: { width?: number; height?: number; scale?: number; frames?: number } = {}): Buffer {
  const width = opts.width ?? 640;
  const height = opts.height ?? 480;
  const y = grey(text, width, height, { scale: opts.scale ?? 8 });
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\n`, 'ascii');
  const frame = Buffer.concat([Buffer.from('FRAME\n', 'ascii'), y, chroma]);
  return Buffer.concat([header, ...Array.from({ length: opts.frames ?? 4 }, () => frame)]);
}

/** Write a fake-camera clip to a fresh temp dir and return its path. */
export function writeQrY4m(text: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memes-qr-'));
  const file = path.join(dir, 'camera.y4m');
  writeFileSync(file, qrY4m(text));
  return file;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** Encode one-byte-per-pixel greyscale pixels as a PNG. */
export function greyPng(width: number, height: number, px: Uint8Array): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let r = 0; r < height; r++) {
    raw[r * (width + 1)] = 0; // filter: none
    raw.set(px.subarray(r * width, (r + 1) * width), r * (width + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Greyscale PNG with the QR placed like in a phone screenshot (grey UI around it). */
export function qrPng(
  text: string,
  opts: { width?: number; height?: number; scale?: number; x?: number; y?: number; bg?: number } = {},
): Buffer {
  const width = opts.width ?? 750;
  const height = opts.height ?? 1334;
  return greyPng(width, height, grey(text, width, height, { scale: opts.scale ?? 6, x: opts.x, y: opts.y, bg: opts.bg ?? 236 }));
}

/** A picture with no QR code in it: a soft diagonal gradient. */
export function plainPng(width = 400, height = 300): Buffer {
  const px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px[y * width + x] = 120 + ((x + y) % 100);
  return greyPng(width, height, px);
}
