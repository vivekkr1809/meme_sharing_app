import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AppServices, ImportImageInput, LibraryMeme } from '../contracts';

export const TABS = ['chat', 'discover', 'make', 'gallery', 'settings'] as const;
export type Tab = (typeof TABS)[number];

function readHash(): Tab {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  return (TABS as readonly string[]).includes(h) ? (h as Tab) : 'chat';
}

/** Minimal hash routing for the main tabs (#/chat, #/discover, …). */
export function useHashTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(readHash);
  useEffect(() => {
    const on = () => setTab(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((t: Tab) => {
    setTab(t);
    if (location.hash !== `#/${t}`) history.replaceState(null, '', `#/${t}`);
  }, []);
  return [tab, go];
}

const NavContext = createContext<(t: Tab) => void>(() => {});
export const NavProvider = NavContext.Provider;
export const useNavigate = () => useContext(NavContext);

// ─── Shared meme flows ──────────────────────────────────────────────────────

/** Store an image in the library and send it to the partner. */
export async function importAndSend(services: AppServices, input: ImportImageInput, replyTo?: string): Promise<LibraryMeme> {
  const meme = await services.library.importImage(input);
  await services.chat.sendMeme(meme.id, undefined, replyTo);
  return meme;
}

/** Store an image in the library and make sure it's a favorite. */
export async function importAndFavorite(services: AppServices, input: ImportImageInput): Promise<LibraryMeme> {
  const meme = await services.library.importImage(input);
  if (!meme.favorite) await services.library.toggleFavorite(meme.id);
  return { ...meme, favorite: true };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
