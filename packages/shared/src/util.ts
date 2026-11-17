import { RELAY_WS_PATH } from './protocol';

/** Normalize a relay base URL ("https://relay.example.com", "localhost:8787") to an http(s) origin+path base. */
export function normalizeRelayBase(base: string): string {
  let b = base.trim();
  if (!/^[a-z]+:\/\//i.test(b)) b = (/^(localhost|127\.|\[::1\])/.test(b) ? 'http://' : 'https://') + b;
  b = b.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  return b.replace(/\/+$/, '');
}

/** "https://relay.example.com" → "wss://relay.example.com/ws" */
export function toWsUrl(base: string): string {
  return normalizeRelayBase(base).replace(/^http/i, 'ws') + RELAY_WS_PATH;
}

/** "https://relay.example.com", "/proxy/x" → "https://relay.example.com/proxy/x" */
export function toHttpUrl(base: string, path: string): string {
  return normalizeRelayBase(base) + (path.startsWith('/') ? path : '/' + path);
}

export type Unsubscribe = () => void;

/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(p: never) => void>>();

  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(cb as (p: never) => void);
    return () => set!.delete(cb as (p: never) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const cb of [...(this.handlers.get(event) ?? [])]) {
      try {
        (cb as (p: Events[K]) => void)(payload);
      } catch (err) {
        console.error(`[emitter] handler for "${String(event)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
