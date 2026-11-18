/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from './src/pwa/pwaConfig';

const RELAY = process.env.RELAY_URL ?? 'http://localhost:8787';

// PWA plugin config is owned by src/pwa (A5): see src/pwa/pwaConfig.ts.
export default defineConfig({
  plugins: [react(), VitePWA(pwaOptions)],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: RELAY.replace(/^http/, 'ws'), ws: true },
      '/proxy': RELAY,
      '/health': RELAY,
      '/config': RELAY,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
