let requested = false;

/** Ask the browser not to evict our IndexedDB (important on iOS). Called once per page; no-op elsewhere. */
export function requestPersistentStorage(): void {
  if (requested) return;
  requested = true;
  try {
    const nav = (globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator;
    const p = nav?.storage?.persist?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // Not available (Node, old browsers): nothing to do.
  }
}
