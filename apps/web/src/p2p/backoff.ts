/**
 * Exponential backoff with jitter: base → base*factor → … capped at maxMs.
 * Each delay is the capped exponential value scaled into [1 - jitter, 1].
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  /** 0..1 — fraction of the delay that is randomized (subtracted). */
  jitter?: number;
  random?: () => number;
}

export interface Backoff {
  /** Delay for the next attempt (and advance the attempt counter). */
  next(): number;
  reset(): void;
  readonly attempts: number;
}

export function createBackoff(opts: BackoffOptions = {}): Backoff {
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 30_000;
  const factor = opts.factor ?? 2;
  const jitter = Math.min(1, Math.max(0, opts.jitter ?? 0.3));
  const random = opts.random ?? Math.random;
  let attempts = 0;
  return {
    next() {
      const raw = Math.min(maxMs, baseMs * Math.pow(factor, attempts));
      attempts = Math.min(attempts + 1, 64);
      return Math.round(raw * (1 - jitter * random()));
    },
    reset() {
      attempts = 0;
    },
    get attempts() {
      return attempts;
    },
  };
}

/** `ms` scaled by a random factor in [1, 1 + spread]. */
export function withJitter(ms: number, spread = 0.5, random: () => number = Math.random): number {
  return Math.round(ms * (1 + spread * random()));
}
