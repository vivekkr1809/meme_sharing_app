import { useSyncExternalStore } from 'react';

/** A value you can read and subscribe to. Subscribers are NOT called on subscribe. */
export interface Readable<T> {
  get(): T;
  subscribe(cb: (value: T) => void): () => void;
}

export interface Writable<T> extends Readable<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

export function writable<T>(initial: T): Writable<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(v) {
      if (Object.is(v, value)) return;
      value = v;
      for (const s of [...subs]) s(v);
    },
    update(fn) {
      this.set(fn(value));
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

/** React binding for Readable. */
export function useReadable<T>(r: Readable<T>): T {
  return useSyncExternalStore(
    (cb) => r.subscribe(() => cb()),
    () => r.get(),
    () => r.get(),
  );
}
