import { describe, expect, it } from 'vitest';
import { defaultBoxes, fitText, fitWithin, layoutCaption, STROKE_RATIO, wrapText, type MeasureFn } from './layout';

/** Monospace stand-in: every char is 0.6em wide. */
const mono: MeasureFn = (text, px) => Array.from(text).length * px * 0.6;

describe('fitWithin', () => {
  it('never upscales', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600, scale: 1 });
  });

  it('caps the longest side at 1600 and keeps aspect ratio', () => {
    expect(fitWithin(4000, 3000)).toMatchObject({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toMatchObject({ width: 1200, height: 1600 });
    expect(fitWithin(1601, 10)).toMatchObject({ width: 1600, height: 10 });
  });

  it('keeps extreme panoramas at least 1px tall', () => {
    expect(fitWithin(100_000, 10)).toMatchObject({ width: 1600, height: 1 });
  });

  it('supports a custom max and rejects bad sizes', () => {
    expect(fitWithin(1000, 500, 100)).toMatchObject({ width: 100, height: 50 });
    expect(() => fitWithin(0, 10)).toThrow(RangeError);
    expect(() => fitWithin(NaN, 10)).toThrow(RangeError);
  });
});

describe('wrapText', () => {
  it('greedily wraps words', () => {
    // 10px font → 6px per char; width 60 → 10 chars per line.
    expect(wrapText('one does not simply walk', 60, 10, mono)).toEqual(['one does', 'not simply', 'walk']);
  });

  it('respects explicit newlines and collapses whitespace', () => {
    expect(wrapText('  top\n\nbottom   line ', 600, 10, mono)).toEqual(['top', '', 'bottom line']);
  });

  it('returns null for a word that cannot fit unless breakWords', () => {
    expect(wrapText('supercalifragilistic', 60, 10, mono)).toBeNull();
    expect(wrapText('supercalifragilistic ok', 60, 10, mono, { breakWords: true })).toEqual(['supercalif', 'ragilistic', 'ok']);
  });
});

describe('fitText', () => {
  it('uses the largest font that fits on one line when possible', () => {
    const r = fitText('HELLO', 300, 100, mono, { minFontPx: 10, maxFontPx: 80 });
    // 5 chars * 0.6 * px ≤ 300 → px ≤ 100, but height 100/1.1 → 90, capped by maxFont 80.
    expect(r).toMatchObject({ fontPx: 80, lines: ['HELLO'], overflow: false });
  });

  it('wraps to more lines rather than shrinking too far', () => {
    const r = fitText('ONE DOES NOT SIMPLY', 300, 200, mono, { minFontPx: 10, maxFontPx: 200 });
    expect(r.lines.length).toBeGreaterThan(1);
    for (const line of r.lines) expect(mono(line, r.fontPx)).toBeLessThanOrEqual(300);
    expect(r.lines.length * r.lineHeightPx).toBeLessThanOrEqual(200);
    // One pixel bigger must not fit.
    const bigger = wrapText('ONE DOES NOT SIMPLY', 300, r.fontPx + 1, mono);
    expect(!bigger || bigger.length * (r.fontPx + 1) * 1.1 > 200).toBe(true);
  });

  it('breaks long words only when nothing else fits, and flags overflow', () => {
    const r = fitText('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 60, 200, mono, { minFontPx: 10, maxFontPx: 50 });
    expect(r.fontPx).toBeGreaterThanOrEqual(10);
    expect(r.lines.length).toBeGreaterThan(1);
    expect(r.overflow).toBe(false);
    const tiny = fitText('A LOT OF WORDS THAT WILL NEVER FIT HERE', 20, 12, mono, { minFontPx: 10, maxFontPx: 50 });
    expect(tiny).toMatchObject({ fontPx: 10, overflow: true });
  });

  it('handles empty text', () => {
    expect(fitText('   ', 100, 100, mono)).toMatchObject({ lines: [], overflow: false });
  });
});

describe('layoutCaption', () => {
  const W = 600;
  const H = 600;

  it('uppercases by default and centers horizontally', () => {
    const l = layoutCaption({ text: 'hello world', x: 0.04, y: 0.02, width: 0.92, height: 0.25 }, W, H, mono);
    expect(l.lines.map((x) => x.text).join(' ')).toBe('HELLO WORLD');
    for (const line of l.lines) expect(line.x).toBeCloseTo(300);
    expect(l.fill).toBe('#ffffff');
    expect(l.stroke).toBe('#000000');
    expect(l.strokePx).toBe(Math.round(l.fontPx * STROKE_RATIO));
  });

  it('keeps case when uppercase is false and honours colors', () => {
    const l = layoutCaption({ text: 'hi', x: 0, y: 0.4, width: 1, height: 0.2, uppercase: false, color: 'red', outlineColor: 'blue' }, W, H, mono);
    expect(l.lines[0]!.text).toBe('hi');
    expect([l.fill, l.stroke]).toEqual(['red', 'blue']);
    // Middle box → vertically centered.
    expect(l.lines[0]!.y).toBeCloseTo(300);
  });

  it('hugs the top of top boxes and the bottom of bottom boxes', () => {
    const [top, bottom] = defaultBoxes({ boxCount: 2 });
    const t = layoutCaption({ ...top!, text: 'top' }, W, H, mono);
    const b = layoutCaption({ ...bottom!, text: 'bottom' }, W, H, mono);
    const topEdge = t.lines[0]!.y - t.fontPx * 0.55;
    const bottomEdge = b.lines.at(-1)!.y + b.fontPx * 0.55;
    expect(topEdge).toBeGreaterThanOrEqual(0.02 * H);
    expect(topEdge).toBeLessThan(0.02 * H + 15);
    expect(bottomEdge).toBeLessThanOrEqual(0.98 * H);
    expect(bottomEdge).toBeGreaterThan(0.98 * H - 15);
  });

  it('keeps every line (with outline) inside the box', () => {
    const box = { text: 'a fairly long caption that has to wrap onto several lines', x: 0.1, y: 0.3, width: 0.5, height: 0.4 };
    const l = layoutCaption(box, W, H, mono);
    for (const line of l.lines) {
      expect(mono(line.text, l.fontPx) + l.fontPx * STROKE_RATIO).toBeLessThanOrEqual(0.5 * W);
      expect(line.y).toBeGreaterThan(0.3 * H);
      expect(line.y).toBeLessThan(0.7 * H);
    }
  });

  it('clamps out-of-range boxes', () => {
    const l = layoutCaption({ text: 'x', x: -1, y: 2, width: 5, height: 5 }, W, H, mono);
    expect(Number.isFinite(l.fontPx)).toBe(true);
  });
});

describe('defaultBoxes', () => {
  it('gives top and bottom for 2 boxes', () => {
    const [top, bottom] = defaultBoxes({ boxCount: 2 });
    expect(top).toMatchObject({ text: '', x: 0.04, y: 0.02, width: 0.92, height: 0.25 });
    expect(bottom!.y + bottom!.height).toBeCloseTo(0.98);
  });

  it('gives a single top box for 1, and 2 for invalid counts', () => {
    expect(defaultBoxes({ boxCount: 1 })).toHaveLength(1);
    expect(defaultBoxes({ boxCount: 0 })).toHaveLength(2);
    expect(defaultBoxes({ boxCount: NaN })).toHaveLength(2);
  });

  it('stacks N boxes evenly without overlap, inside the image', () => {
    for (const n of [3, 4, 5, 8]) {
      const boxes = defaultBoxes({ boxCount: n });
      expect(boxes).toHaveLength(n);
      const heights = new Set(boxes.map((b) => b.height.toFixed(6)));
      expect(heights.size).toBe(1);
      for (let i = 1; i < n; i++) expect(boxes[i]!.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height);
      expect(boxes[0]!.y).toBeGreaterThanOrEqual(0);
      expect(boxes.at(-1)!.y + boxes.at(-1)!.height).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('caps absurd counts', () => {
    expect(defaultBoxes({ boxCount: 500 })).toHaveLength(20);
  });
});
