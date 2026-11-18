import { normalizePassword } from '@memes/shared';
import type { LockService, LockState } from '../../contracts';
import { backoffMs, DEFAULT_AUTO_LOCK_MINUTES, isValidAutoLockMinutes, isWeakPasscode } from '../../db/lock';
import { writable } from '../../lib/store';

export interface MockLockOptions {
  /** Multiplies the artificial "deriving the key" delay. */
  timeScale?: number;
  now?: () => number;
  /** Called when the lock closes (the mock stops "syncing") and when it opens again. */
  onLock?: () => void;
  onUnlock?: () => void;
}

export type MockLock = LockService & {
  isLocked(): boolean;
  /** Back to 'disabled' with defaults (pairing.wipe). */
  reset(): void;
  dispose(): void;
};

/**
 * In-memory LockService for ?demo and component tests. Same states, errors, back-off schedule
 * and auto-lock behaviour as the real one (src/sync/engine.ts), but nothing is encrypted: the
 * mock keeps nothing on disk anyway.
 */
export function createMockLock(opts: MockLockOptions = {}): MockLock {
  const scale = opts.timeScale ?? 1;
  const now = opts.now ?? (() => Date.now());
  const state = writable<LockState>('disabled');
  const autoLockMinutes = writable(DEFAULT_AUTO_LOCK_MINUTES);
  const retryAfterMs = writable(0);
  let passcode: string | null = null;
  let failures = 0;
  let lockedUntil = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt: number | null = null;

  const kdfDelay = () => new Promise<void>((r) => setTimeout(r, 250 * scale));

  const tick = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const ms = Math.max(0, lockedUntil - now());
    retryAfterMs.set(ms);
    if (ms > 0) retryTimer = setTimeout(tick, Math.min(1000, ms));
  };

  const verify = async (code: string) => {
    if (lockedUntil > now()) {
      tick();
      throw new Error('too-many-attempts');
    }
    failures++;
    await kdfDelay();
    if (typeof code !== 'string' || passcode === null || normalizePassword(code) !== passcode) {
      lockedUntil = now() + backoffMs(failures);
      tick();
      throw new Error('wrong-passcode');
    }
    failures = 0;
    lockedUntil = 0;
    tick();
  };

  const close = () => {
    if (state.get() !== 'unlocked') return;
    state.set('locked');
    opts.onLock?.();
  };

  const doc = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null;
  const onVisibility = () => {
    const ms = autoLockMinutes.get() * 60_000;
    if (doc!.visibilityState === 'hidden') {
      hiddenAt = now();
      if (state.get() !== 'unlocked') return;
      if (autoTimer) clearTimeout(autoTimer);
      if (ms === 0) close();
      else autoTimer = setTimeout(close, ms);
    } else {
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = null;
      if (hiddenAt !== null && now() - hiddenAt >= ms) close();
      hiddenAt = null;
    }
  };
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    state,
    autoLockMinutes,
    retryAfterMs,
    async enable(code) {
      if (isWeakPasscode(code)) throw new Error('weak-passcode');
      if (state.get() !== 'disabled') throw new Error('already-enabled');
      await kdfDelay();
      passcode = normalizePassword(code);
      failures = 0;
      lockedUntil = 0;
      state.set('unlocked');
    },
    async disable(code) {
      if (state.get() === 'locked') throw new Error('locked');
      if (state.get() === 'disabled') return;
      await verify(code);
      passcode = null;
      state.set('disabled');
    },
    async change(oldCode, newCode) {
      if (isWeakPasscode(newCode)) throw new Error('weak-passcode');
      if (state.get() === 'locked') throw new Error('locked');
      if (state.get() === 'disabled') throw new Error('not-enabled');
      await verify(oldCode);
      passcode = normalizePassword(newCode);
    },
    async unlock(code) {
      if (state.get() !== 'locked') return;
      await verify(code);
      state.set('unlocked');
      opts.onUnlock?.();
    },
    async lockNow() {
      close();
    },
    async setAutoLockMinutes(m) {
      if (!isValidAutoLockMinutes(m)) throw new Error('invalid-minutes');
      autoLockMinutes.set(m);
    },
    isLocked: () => state.get() === 'locked',
    reset() {
      passcode = null;
      failures = 0;
      lockedUntil = 0;
      tick();
      autoLockMinutes.set(DEFAULT_AUTO_LOCK_MINUTES);
      state.set('disabled');
    },
    dispose() {
      doc?.removeEventListener('visibilitychange', onVisibility);
      if (retryTimer) clearTimeout(retryTimer);
      if (autoTimer) clearTimeout(autoTimer);
    },
  };
}
