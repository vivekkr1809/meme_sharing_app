import { writable, type Readable } from '../lib/store';

/** The non-standard Chromium install prompt event. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const deferred = writable<BeforeInstallPromptEvent | null>(null);
const installed = writable(false);

/** The captured install prompt (Chromium/Android), or null. */
export const installPrompt: Readable<BeforeInstallPromptEvent | null> = deferred;
export const appInstalled: Readable<boolean> = installed;

let listening = false;
/** Call as early as possible (main.tsx): the event can fire before React mounts. */
export function listenForInstallPrompt() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred.set(e as BeforeInstallPromptEvent);
  });
  window.addEventListener('appinstalled', () => {
    deferred.set(null);
    installed.set(true);
  });
}

export async function promptInstall(): Promise<boolean> {
  const e = deferred.get();
  if (!e) return false;
  await e.prompt();
  const { outcome } = await e.userChoice;
  deferred.set(null);
  return outcome === 'accepted';
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
}

/** iPhone/iPad Safari (where installing is a manual Share → Add to Home Screen). */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || iPadOs;
}

const DISMISS_KEY = 'memepals.installHintDismissed';

export function hintDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissHint() {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* private mode */
  }
}
