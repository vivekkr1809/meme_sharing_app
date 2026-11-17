export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  { timeout = 5000, interval = 10, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
