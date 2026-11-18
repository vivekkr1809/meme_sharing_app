import type { CaptionBox, MemeTemplate } from '../contracts';

/** Longest side of any image we produce. */
export const MAX_DIMENSION = 1600;

/** Classic meme font: system fonts only, nothing is downloaded. */
export const MEME_FONT_STACK = 'Impact, Haettenschweiler, "Arial Narrow Bold", "Anton", "Arial Black", sans-serif';
export const memeFont = (px: number): string => `bold ${px}px ${MEME_FONT_STACK}`;

/** Width of `text` rendered at `fontPx`. In the browser: ctx.measureText. */
export type MeasureFn = (text: string, fontPx: number) => number;

// ─── Resize math ────────────────────────────────────────────────────────────

/** Scale (w, h) down (never up) so the longest side is ≤ max. Keeps aspect ratio; dims are ≥ 1. */
export function fitWithin(width: number, height: number, max = MAX_DIMENSION): { width: number; height: number; scale: number } {
  if (!(width > 0) || !(height > 0)) throw new RangeError(`Invalid image size ${width}x${height}`);
  const scale = Math.min(1, max / Math.max(width, height));
  if (scale === 1) return { width: Math.round(width), height: Math.round(height), scale };
  return {
    width: Math.max(1, Math.min(max, Math.round(width * scale))),
    height: Math.max(1, Math.min(max, Math.round(height * scale))),
    scale,
  };
}

// ─── Text wrapping and fitting ──────────────────────────────────────────────

/** Split a word into pieces that each fit maxWidth (at least one char per piece). */
function breakWord(word: string, maxWidth: number, fontPx: number, measure: MeasureFn): string[] {
  const chars = Array.from(word);
  const out: string[] = [];
  let cur = '';
  for (const ch of chars) {
    const next = cur + ch;
    if (cur && measure(next, fontPx) > maxWidth) {
      out.push(cur);
      cur = ch;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Greedy word wrap. Explicit newlines start new lines. Returns null if a single word
 * is wider than maxWidth and breakWords is false; with breakWords, long words are
 * split across lines.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontPx: number,
  measure: MeasureFn,
  opts: { breakWords?: boolean } = {},
): string[] | null {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let cur = '';
    for (const word of words) {
      if (measure(word, fontPx) > maxWidth) {
        if (!opts.breakWords) return null;
        if (cur) lines.push(cur);
        const pieces = breakWord(word, maxWidth, fontPx, measure);
        cur = pieces.pop() ?? '';
        lines.push(...pieces);
        continue;
      }
      const candidate = cur ? `${cur} ${word}` : word;
      if (cur && measure(candidate, fontPx) > maxWidth) {
        lines.push(cur);
        cur = word;
      } else cur = candidate;
    }
    lines.push(cur);
  }
  // Drop leading/trailing blank lines (but keep intentional blank lines in the middle).
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface FitOptions {
  maxFontPx?: number;
  minFontPx?: number;
  /** Line height as a multiple of the font size. */
  lineHeight?: number;
}

export interface FitResult {
  fontPx: number;
  lines: string[];
  lineHeightPx: number;
  /** True if even the minimum font size doesn't fit the box. */
  overflow: boolean;
}

/**
 * Find the largest integer font size at which `text` wraps into the box.
 * Prefers sizes that don't split words; only breaks words if nothing else fits.
 */
export function fitText(text: string, boxWidth: number, boxHeight: number, measure: MeasureFn, opts: FitOptions = {}): FitResult {
  const lineHeight = opts.lineHeight ?? 1.1;
  const minFont = Math.max(1, Math.floor(opts.minFontPx ?? 10));
  const maxFont = Math.max(minFont, Math.floor(opts.maxFontPx ?? Math.max(minFont, boxHeight)));
  const trimmed = text.trim();
  if (!trimmed) return { fontPx: maxFont, lines: [], lineHeightPx: maxFont * lineHeight, overflow: false };

  const tryAt = (px: number, breakWords: boolean): string[] | null => {
    const lines = wrapText(trimmed, boxWidth, px, measure, { breakWords });
    if (!lines) return null;
    return lines.length * px * lineHeight <= boxHeight ? lines : null;
  };
  const search = (breakWords: boolean): FitResult | null => {
    let lo = minFont;
    let hi = maxFont;
    let best: FitResult | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const lines = tryAt(mid, breakWords);
      if (lines) {
        best = { fontPx: mid, lines, lineHeightPx: mid * lineHeight, overflow: false };
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  };

  const fit = search(false) ?? search(true);
  if (fit) return fit;
  const lines = wrapText(trimmed, boxWidth, minFont, measure, { breakWords: true }) ?? [trimmed];
  return { fontPx: minFont, lines, lineHeightPx: minFont * lineHeight, overflow: true };
}

// ─── Caption layout ─────────────────────────────────────────────────────────

export interface CaptionLine {
  text: string;
  /** Horizontal center of the line, in image pixels. */
  x: number;
  /** Vertical center of the line, in image pixels (draw with textBaseline 'middle'). */
  y: number;
}

export interface CaptionLayout {
  fontPx: number;
  strokePx: number;
  lines: CaptionLine[];
  overflow: boolean;
  fill: string;
  stroke: string;
}

/** Outline width as a fraction of the font size. */
export const STROKE_RATIO = 1 / 8;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Lay out one caption box on an image of imageW × imageH pixels. Pure: drawing is
 * done by the caller. Text hugs the top of boxes in the upper third, the bottom of
 * boxes in the lower third, and is centered otherwise (classic meme placement).
 */
export function layoutCaption(box: CaptionBox, imageW: number, imageH: number, measure: MeasureFn): CaptionLayout {
  const text = box.uppercase === false ? box.text : box.text.toLocaleUpperCase();
  const x0 = clamp01(box.x) * imageW;
  const y0 = clamp01(box.y) * imageH;
  const w = Math.max(1, Math.min(imageW - x0, clamp01(box.width) * imageW));
  const h = Math.max(1, Math.min(imageH - y0, clamp01(box.height) * imageH));
  const pad = Math.max(2, Math.min(w, h) * 0.04);
  const innerW = Math.max(1, w - 2 * pad);
  const innerH = Math.max(1, h - 2 * pad);
  const minFontPx = Math.max(8, Math.round(Math.min(imageW, imageH) * 0.025));
  const maxFontPx = Math.max(minFontPx, Math.round(Math.min(innerH, Math.max(imageW, imageH) * 0.12)));
  // The outline extends past the glyphs on both sides.
  const measureStroked: MeasureFn = (t, px) => measure(t, px) + px * STROKE_RATIO;
  const fit = fitText(text, innerW, innerH, measureStroked, { minFontPx, maxFontPx, lineHeight: 1.1 });

  const blockH = fit.lines.length * fit.lineHeightPx;
  const center = clamp01(box.y) + clamp01(box.height) / 2;
  let top: number;
  if (center < 1 / 3) top = y0 + pad;
  else if (center > 2 / 3) top = y0 + h - pad - blockH;
  else top = y0 + (h - blockH) / 2;

  return {
    fontPx: fit.fontPx,
    strokePx: Math.max(1, Math.round(fit.fontPx * STROKE_RATIO)),
    overflow: fit.overflow,
    fill: box.color ?? '#ffffff',
    stroke: box.outlineColor ?? '#000000',
    lines: fit.lines.map((t, i) => ({ text: t, x: x0 + w / 2, y: top + (i + 0.5) * fit.lineHeightPx })),
  };
}

// ─── Default boxes ──────────────────────────────────────────────────────────

const MARGIN_X = 0.04;
const MARGIN_Y = 0.02;

/** Top/bottom for 2 boxes, a single top box for 1, evenly stacked for N ≥ 3. */
export function defaultBoxes(template: Pick<MemeTemplate, 'boxCount'>): CaptionBox[] {
  const raw = Math.floor(template.boxCount);
  const n = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 20) : 2;
  const base = { text: '', x: MARGIN_X, width: 1 - 2 * MARGIN_X };
  if (n === 1) return [{ ...base, y: MARGIN_Y, height: 0.25 }];
  if (n === 2)
    return [
      { ...base, y: MARGIN_Y, height: 0.25 },
      { ...base, y: 1 - MARGIN_Y - 0.25, height: 0.25 },
    ];
  const gap = 0.02;
  const h = (1 - 2 * MARGIN_Y - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ ...base, y: MARGIN_Y + i * (h + gap), height: h }));
}
