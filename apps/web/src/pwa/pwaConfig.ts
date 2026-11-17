import type { VitePWAOptions } from 'vite-plugin-pwa';

export const THEME_COLOR = '#7c3aed';
export const BACKGROUND_COLOR = '#f7f3ff';

/**
 * vite-plugin-pwa options (imported by vite.config.ts).
 *
 * Privacy: Workbox precaches ONLY the app shell (our own JS/CSS/HTML/icons).
 * There is deliberately no `runtimeCaching`: Reddit, Imgflip and relay-proxy
 * responses are never written to the Cache Storage. Memes the user keeps are
 * stored in IndexedDB by the app itself.
 */
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'autoUpdate',
  strategies: 'generateSW',
  // We register ourselves in src/pwa/register.ts (to show an update toast).
  injectRegister: false,
  manifest: {
    id: '/',
    name: 'Meme Pals',
    short_name: 'Meme Pals',
    description: 'A private meme-sharing chat for two. Everything stays on your phones.',
    lang: 'en',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    categories: ['social', 'entertainment'],
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [/^\/ws/, /^\/proxy/, /^\/config/, /^\/health/],
    runtimeCaching: [],
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: true,
  },
  devOptions: { enabled: false },
};
