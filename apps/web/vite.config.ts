/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const RELAY = process.env.RELAY_URL ?? 'http://localhost:8787';

// PWA plugin config is owned by src/pwa (A5) and added here during Wave 1.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: RELAY.replace(/^http/, 'ws'), ws: true },
      '/proxy': RELAY,
      '/health': RELAY,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
