import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Two-device end-to-end suite (Playwright driven from vitest).
 * Run with `pnpm test:e2e` (builds the web app first). Not part of `pnpm test`.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['e2e/tests/**/*.e2e.ts'],
    environment: 'node',
    pool: 'forks',
    // Each file runs its own browser + relay; a few at once keeps the run short.
    maxWorkers: 3,
    testTimeout: 90_000,
    hookTimeout: 60_000,
    teardownTimeout: 20_000,
  },
});
