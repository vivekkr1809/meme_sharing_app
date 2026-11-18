import type { LockService } from '../contracts';
import { writable } from './store';

/** Placeholder LockService: no passcode support. Replaced by the real lock (src/db + src/sync). */
export function createDisabledLock(): LockService {
  const notYet = async () => {
    throw new Error('not-implemented');
  };
  return {
    state: writable('disabled' as const),
    autoLockMinutes: writable(5),
    retryAfterMs: writable(0),
    enable: notYet,
    disable: notYet,
    change: notYet,
    unlock: notYet,
    lockNow: async () => {},
    setAutoLockMinutes: notYet,
  };
}
