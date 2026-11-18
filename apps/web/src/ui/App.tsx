import { useCallback, useEffect, useState } from 'react';
import type { AppServices } from '../contracts';
import { InstallBanner } from '../pwa/InstallHint';
import { UpdateToast } from '../pwa/UpdateToast';
import { useReadable } from '../lib/store';
import { ServicesProvider, useProfile, useServices, useSettings, useUnreadCount } from './context';
import { Icon, type IconName } from './components/Icon';
import { ConfirmProvider } from './components/Modal';
import { ToastProvider } from './components/Toast';
import { NavProvider, TABS, useHashTab, type Tab } from './nav';
import { Chat } from './screens/Chat';
import { Discover } from './screens/Discover';
import { Gallery } from './screens/Gallery';
import { LockScreen } from './screens/Lock';
import { Make } from './screens/Make';
import { Onboarding } from './screens/Onboarding';
import { Pairing } from './screens/Pairing';
import { Settings } from './screens/Settings';
import './styles.css';

export { ServicesProvider, useServices } from './context';

export function App({ services }: { services: AppServices }) {
  return (
    <ServicesProvider services={services}>
      <ThemeSync />
      <ToastProvider>
        <ConfirmProvider>
          <UpdateToast />
          <LockGate />
        </ConfirmProvider>
      </ToastProvider>
    </ServicesProvider>
  );
}

const THEME_COLORS = { light: '#fbf9ff', dark: '#16121d' };

/** Applies settings.theme to <html data-theme> (CSS variables do the rest). */
function ThemeSync() {
  const { theme } = useSettings();
  useEffect(() => {
    const root = document.documentElement;
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const apply = () => {
      const resolved = theme === 'system' ? (mq?.matches ? 'dark' : 'light') : theme;
      if (theme === 'system') delete root.dataset.theme;
      else root.dataset.theme = theme;
      root.style.colorScheme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[resolved]);
    };
    apply();
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [theme]);
  return null;
}

/** While the passcode lock is closed nothing but the lock screen renders (no data is loaded anyway). */
function LockGate() {
  const state = useReadable(useServices().lock.state);
  if (state === 'locked') return <LockScreen />;
  return <Root />;
}

function Root() {
  const profile = useProfile();
  const [pairingFlow, setPairingFlow] = useState(false);
  // Enter the pairing flow whenever we're not paired; stay in it until it says it's done
  // (createPairing marks the profile paired immediately, before the partner connects).
  if (profile && !profile.paired && !pairingFlow) setPairingFlow(true);
  const done = useCallback(() => {
    // Always land in the chat after (re-)pairing, not on whichever tab was open before (e.g. Settings → Unpair).
    if (location.hash !== '#/chat') history.replaceState(null, '', '#/chat');
    setPairingFlow(false);
  }, []);

  if (!profile) return <Onboarding />;
  if (pairingFlow) return <Pairing onDone={done} />;
  return <MainShell />;
}

const TAB_META: Record<Tab, { label: string; icon: IconName }> = {
  chat: { label: 'Chat', icon: 'chat' },
  discover: { label: 'Discover', icon: 'compass' },
  make: { label: 'Make', icon: 'wand' },
  gallery: { label: 'Gallery', icon: 'gallery' },
  settings: { label: 'Settings', icon: 'gear' },
};

function MainShell() {
  const [tab, go] = useHashTab();
  const unread = useUnreadCount();
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set(visited).add(tab));

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) Meme Pals` : 'Meme Pals';
  }, [unread]);

  return (
    <NavProvider value={go}>
      <div className="shell">
        <div className="screens">
          {TABS.filter((t) => visited.has(t)).map((t) => (
            <div key={t} className="screen-host" hidden={t !== tab}>
              {t === 'chat' && <Chat active={tab === 'chat'} />}
              {t === 'discover' && <Discover active={tab === 'discover'} />}
              {t === 'make' && <Make active={tab === 'make'} />}
              {t === 'gallery' && <Gallery active={tab === 'gallery'} />}
              {t === 'settings' && <Settings />}
            </div>
          ))}
        </div>
        {(tab === 'discover' || tab === 'gallery') && <InstallBanner />}
        <nav className="tabbar" aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={`tab ${t === tab ? 'is-on' : ''}`}
              aria-current={t === tab ? 'page' : undefined}
              onClick={() => go(t)}
              aria-label={t === 'chat' && unread > 0 ? `Chat, ${unread} unread` : TAB_META[t].label}
            >
              <span className="tab-icon">
                <Icon name={TAB_META[t].icon} size={24} filled={false} />
                {t === 'chat' && unread > 0 && (
                  <span className="badge-count" aria-hidden="true">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </span>
              <span className="tab-label">{TAB_META[t].label}</span>
            </button>
          ))}
        </nav>
      </div>
    </NavProvider>
  );
}
