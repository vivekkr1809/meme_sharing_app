import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppServices, LibraryMeme } from '../contracts';
import { useReadable } from '../lib/store';

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('useServices() must be used inside <ServicesProvider>');
  return s;
}

// ─── Readable hooks ─────────────────────────────────────────────────────────

export const useProfile = () => useReadable(useServices().pairing.profile);
export const useSettings = () => useReadable(useServices().settings.settings);
export const useConnection = () => useReadable(useServices().chat.connection);
export const useMessages = () => useReadable(useServices().chat.messages);
export const usePartnerTyping = () => useReadable(useServices().chat.partnerTyping);
export const useUnreadCount = () => useReadable(useServices().chat.unreadCount);
export const useLibraryVersion = () => useReadable(useServices().library.version);

/** Partner's display name, with a friendly fallback. */
export function usePartnerName(): string {
  return useProfile()?.partnerName ?? 'your partner';
}

/**
 * Resolve a meme's display URL and metadata from the local library.
 * Re-checks whenever the library version changes (e.g. the image finished arriving).
 */
export function useMeme(memeId: string | undefined): { url: string | null; meta: LibraryMeme | undefined } {
  const { library } = useServices();
  const version = useLibraryVersion();
  const [state, setState] = useState<{ id?: string; url: string | null; meta?: LibraryMeme }>({ url: null });
  useEffect(() => {
    if (!memeId) return;
    let alive = true;
    void Promise.all([library.getUrl(memeId), library.get(memeId)]).then(
      ([url, meta]) => {
        if (alive) setState((s) => (s.id === memeId && s.url === url && s.meta === meta ? s : { id: memeId, url, meta }));
      },
      () => {
        /* stays as placeholder */
      },
    );
    return () => {
      alive = false;
    };
  }, [library, memeId, version]);
  if (state.id !== memeId) return { url: null, meta: undefined };
  return { url: state.url, meta: state.meta };
}

/** Value that only updates after `ms` of no changes. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
