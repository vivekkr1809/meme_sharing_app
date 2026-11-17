import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { listenForInstallPrompt } from './pwa/install';
import { registerServiceWorker } from './pwa/register';
import { App } from './ui/App';
import { createMockServices, mockOptionsFromQuery } from './ui/mock/createMockServices';

// Wave 1: the UI runs on in-memory mock services (also usable later as a demo mode:
// "?demo", "?demo=onboarded", "?demo=paired", "&partner=offline").
// The integrator replaces this with the real createDataServices + createMemeServices.
listenForInstallPrompt();
const services = createMockServices(mockOptionsFromQuery(location.search));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);

if (import.meta.env.PROD) void registerServiceWorker();
