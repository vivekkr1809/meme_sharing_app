import { describe, expect, it } from 'vitest';
import { createBackoff, withJitter } from '../backoff';

describe('backoff', () => {
  it('doubles from 1s up to the 30s cap without jitter', () => {
    const b = createBackoff({ jitter: 0 });
    const seq = Array.from({ length: 8 }, () => b.next());
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(b.attempts).toBe(8);
    b.reset();
    expect(b.next()).toBe(1000);
  });

  it('jitter only shortens delays, within the configured fraction', () => {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const b = createBackoff({ jitter: 0.3, random: () => r });
      for (let i = 0; i < 10; i++) {
        const raw = Math.min(30_000, 1000 * 2 ** i);
        const d = b.next();
        expect(d).toBeLessThanOrEqual(raw);
        expect(d).toBeGreaterThanOrEqual(Math.floor(raw * 0.7));
      }
    }
  });

  it('respects custom base/max', () => {
    const b = createBackoff({ baseMs: 50, maxMs: 120, jitter: 0 });
    expect([b.next(), b.next(), b.next(), b.next()]).toEqual([50, 100, 120, 120]);
  });

  it('withJitter extends a delay by up to the spread', () => {
    expect(withJitter(1000, 0.5, () => 0)).toBe(1000);
    expect(withJitter(1000, 0.5, () => 1)).toBe(1500);
  });
});
