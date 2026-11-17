import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppServices } from './contracts';
import { listenForInstallPrompt } from './pwa/install';
import { registerServiceWorker } from './pwa/register';
import { App } from './ui/App';

/**
 * Entry point.
 *   default   → real services: IndexedDB on this device + WebRTC to your partner.
 *   ?demo...  → in-memory mock services (no network, nothing stored). See ui/mock.
 */
listenForInstallPrompt();
const root = createRoot(document.getElementById('root')!);

function Splash({ error }: { error?: string }) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}
    >
      {error ? (
        <div style={{ maxWidth: 360 }}>
          <h1 style={{ fontSize: 20 }}>Meme Pals couldn't start</h1>
          <p>{error}</p>
          <button onClick={() => location.reload()}>Try again</button>
        </div>
      ) : (
        <p>Loading your memes…</p>
      )}
    </div>
  );
}

async function loadServices(): Promise<AppServices> {
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    const { createMockServices, mockOptionsFromQuery } = await import('./ui/mock/createMockServices');
    return createMockServices(mockOptionsFromQuery(location.search));
  }
  const { createAppServices } = await import('./services/createAppServices');
  return createAppServices();
}

root.render(<Splash />);
loadServices().then(
  (services) =>
    root.render(
      <StrictMode>
        <App services={services} />
      </StrictMode>,
    ),
  (err: unknown) => {
    console.error('[meme-pals] startup failed', err);
    root.render(
      <Splash error="This browser blocked local storage (IndexedDB). Private/incognito windows often do this. Open Meme Pals in a normal window, or install it to your Home Screen." />,
    );
  },
);

if (import.meta.env.PROD) void registerServiceWorker();
