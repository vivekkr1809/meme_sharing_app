import { normalizeRelayBase, SUBREDDIT_PATTERN } from '@memes/shared';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Theme } from '../../contracts';
import { InstallCard } from '../../pwa/InstallHint';
import { useConnection, useProfile, useServices, useSettings } from '../context';
import { friendlyError } from '../errors';
import { backupFileName } from '../format';
import { Segmented, Switch } from '../components/Controls';
import { Icon } from '../components/Icon';
import { useConfirm } from '../components/Modal';
import { useToast } from '../components/Toast';
import { downloadBlob } from '../nav';

const MAX_SUBS = 20;

/** "r/Memes " → "Memes"; returns null if it isn't a valid subreddit name. */
export function cleanSubreddit(input: string): string | null {
  const s = input.trim().replace(/^\/?r\//i, '').replace(/\/$/, '');
  return SUBREDDIT_PATTERN.test(s) ? s : null;
}

export function validateRelayUrl(v: string): string | null {
  if (!v.trim()) return null;
  try {
    const u = new URL(normalizeRelayBase(v));
    if (!/^(https?|wss?):$/.test(u.protocol)) return 'Use an http(s) address.';
    return null;
  } catch {
    return "That doesn't look like a web address.";
  }
}

export function Settings() {
  return (
    <section className="screen settings" aria-label="Settings">
      <header className="topbar">
        <h1 className="topbar-title big">Settings</h1>
      </header>
      <div className="scroll settings-scroll">
        <ProfileSection />
        <AppearanceSection />
        <MemesSection />
        <ConnectionSection />
        <InstallCard />
        <BackupSection />
        <PrivacySection />
        <DangerSection />
        <p className="fineprint center">Meme Pals · made for two · v{import.meta.env.VITE_APP_VERSION ?? '0.1.0'}</p>
      </div>
    </section>
  );
}

function Group({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section className="group" aria-labelledby={id}>
      <h2 className="group-title" id={id}>
        {title}
      </h2>
      <div className="card">{children}</div>
    </section>
  );
}

function ProfileSection() {
  const { pairing } = useServices();
  const profile = useProfile();
  const connection = useConnection();
  const toast = useToast();
  const [name, setName] = useState(profile?.displayName ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(profile?.displayName ?? ''), [profile?.displayName]);
  const dirty = name.trim() !== (profile?.displayName ?? '');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await pairing.setDisplayName(name);
      toast.success('Name updated');
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <Group title="You" id="g-profile">
      <form className="form" onSubmit={save} noValidate>
        <label className="label" htmlFor="set-name">
          Display name
        </label>
        <div className="input-with-btn">
          <input id="set-name" className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || !name.trim()}>
            Save
          </button>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="row-info">
        <span className={`status-dot status-${connection}`} aria-hidden="true" />
        <span>
          {profile?.paired
            ? profile.partnerName
              ? `Paired with ${profile.partnerName}`
              : 'Paired, waiting for your partner to connect'
            : 'Not paired'}
        </span>
      </div>
    </Group>
  );
}

function AppearanceSection() {
  const { settings } = useServices();
  const s = useSettings();
  return (
    <Group title="Appearance" id="g-appearance">
      <div className="field">
        <span className="label" id="theme-label">
          Theme
        </span>
        <Segmented<Theme>
          label="Theme"
          value={s.theme}
          onChange={(theme) => void settings.update({ theme })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: '☀️ Light' },
            { value: 'dark', label: '🌙 Dark' },
          ]}
        />
      </div>
    </Group>
  );
}

function MemesSection() {
  const { settings } = useServices();
  const s = useSettings();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = cleanSubreddit(draft);
    if (!name) {
      setError('Subreddit names are 2–32 letters, numbers or underscores.');
      return;
    }
    if (s.subreddits.some((x) => x.toLowerCase() === name.toLowerCase())) {
      setError(`r/${name} is already in your list.`);
      return;
    }
    if (s.subreddits.length >= MAX_SUBS) {
      setError(`You can have up to ${MAX_SUBS} subreddits.`);
      return;
    }
    setError(null);
    setDraft('');
    void settings.update({ subreddits: [...s.subreddits, name] });
  };

  const remove = (name: string) => {
    if (s.subreddits.length <= 1) {
      setError('Keep at least one subreddit.');
      return;
    }
    setError(null);
    void settings.update({ subreddits: s.subreddits.filter((x) => x !== name) });
  };

  return (
    <Group title="Memes" id="g-memes">
      <div className="field">
        <span className="label">Subreddits in Discover</span>
        <ul className="sub-list" aria-label="Subreddits">
          {s.subreddits.map((x) => (
            <li key={x} className="sub-chip">
              r/{x}
              <button type="button" aria-label={`Remove r/${x}`} onClick={() => remove(x)}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
        <form className="input-with-btn" onSubmit={add} noValidate>
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a subreddit, e.g. aww"
            aria-label="Add a subreddit"
            aria-invalid={!!error}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="btn btn-soft btn-sm" disabled={!draft.trim()}>
            Add
          </button>
        </form>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Switch label="Hide NSFW posts" description="Hides posts marked NSFW or spoiler in Discover." checked={s.hideNsfw} onChange={(hideNsfw) => void settings.update({ hideNsfw })} />
    </Group>
  );
}

function ConnectionSection() {
  const { settings } = useServices();
  const s = useSettings();
  const toast = useToast();
  const [url, setUrl] = useState(s.relayUrl);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setUrl(s.relayUrl), [s.relayUrl]);
  const dirty = url.trim() !== s.relayUrl;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateRelayUrl(url);
    setError(err);
    if (err) return;
    const v = url.trim() ? normalizeRelayBase(url) : '';
    await settings.update({ relayUrl: v });
    setUrl(v);
    toast.success(v ? 'Relay updated' : 'Using this app’s own server as relay');
  };

  return (
    <Group title="Connection" id="g-conn">
      <form className="form" onSubmit={save} noValidate>
        <label className="label" htmlFor="relay-url">
          Relay server
        </label>
        <div className="input-with-btn">
          <input
            id="relay-url"
            className="input"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Same as this app"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby="relay-hint"
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty}>
            Save
          </button>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <p className="hint" id="relay-hint">
          Leave blank to use the server this app was loaded from. Both of you must use the same relay. It only introduces your phones; it never sees messages or memes.
        </p>
      </form>
    </Group>
  );
}

function BackupSection() {
  const { backup } = useServices();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);

  const doExport = async () => {
    setBusy('export');
    try {
      const blob = await backup.exportBackup();
      downloadBlob(blob, backupFileName());
      toast.success('Backup downloaded');
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't create a backup."));
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (f: File | undefined) => {
    if (!f) return;
    setBusy('import');
    try {
      const r = await backup.importBackup(f);
      toast.success(`Imported ${r.messages} message${r.messages === 1 ? '' : 's'} and ${r.memes} meme${r.memes === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't import that backup."));
    } finally {
      setBusy(null);
      if (file.current) file.current.value = '';
    }
  };

  return (
    <Group title="Backup" id="g-backup">
      <p className="hint">Your history only lives on this phone. Save a backup file now and then, and keep it somewhere safe. It isn't encrypted.</p>
      <div className="btn-row">
        <button type="button" className="btn btn-soft" onClick={doExport} disabled={!!busy}>
          {busy === 'export' ? <span className="spinner sm" /> : <Icon name="download" size={18} />} Export backup
        </button>
        <button type="button" className="btn btn-soft" onClick={() => file.current?.click()} disabled={!!busy}>
          {busy === 'import' ? <span className="spinner sm" /> : <Icon name="upload" size={18} />} Import backup
        </button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => void doImport(e.target.files?.[0])} aria-label="Backup file" data-testid="backup-file" />
      </div>
    </Group>
  );
}

function PrivacySection() {
  return (
    <Group title="Privacy: what leaves this phone" id="g-privacy">
      <ul className="privacy-list">
        <li>
          <strong>Meme browsing.</strong> Discover and Make download images and lists from Reddit and Imgflip, either directly or through your relay's pass-through proxy when the
          browser blocks direct requests. Those sites see an ordinary anonymous request; they don't know who you send memes to.
        </li>
        <li>
          <strong>Signaling via the relay.</strong> To find each other, your phones exchange short connection offers through the relay. They're signed with your pairing key, the
          room id is a scrambled hash, and the relay keeps nothing in memory after the handshake and nothing on disk.
        </li>
        <li>
          <strong>Your partner, and only your partner.</strong> Messages, reactions and meme images travel directly to your partner's phone over an encrypted WebRTC connection.
          On some networks an optional TURN server forwards that already-encrypted stream without being able to read it.
        </li>
        <li>
          <strong>Nothing else.</strong> No accounts, analytics, ads, trackers or cloud storage. Everything else, including your history, favorites and settings, stays on this
          device. The app works offline once installed.
        </li>
      </ul>
    </Group>
  );
}

function DangerSection() {
  const { pairing } = useServices();
  const profile = useProfile();
  const confirm = useConfirm();
  const toast = useToast();
  const partner = profile?.partnerName ?? 'your partner';

  const unpair = async () => {
    const ok = await confirm({
      title: `Unpair from ${partner}?`,
      body: 'Your phones will stop connecting. Your chat history and memes stay on this device. You can pair again with a new code.',
      confirmLabel: 'Unpair',
      danger: true,
    });
    if (!ok) return;
    try {
      await pairing.unpair();
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  const wipe = async () => {
    const ok = await confirm({
      title: 'Wipe all data?',
      body: 'This permanently deletes every message, meme, favorite and setting on this device. It cannot be undone. Export a backup first if you might want it later.',
      confirmLabel: 'Wipe everything',
      danger: true,
    });
    if (!ok) return;
    try {
      await pairing.wipe();
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  return (
    <Group title="Danger zone" id="g-danger">
      <div className="btn-col">
        {profile?.paired && (
          <button type="button" className="btn btn-danger-soft" onClick={unpair}>
            Unpair
          </button>
        )}
        <button type="button" className="btn btn-danger" onClick={wipe}>
          <Icon name="trash" size={18} /> Wipe all data
        </button>
      </div>
    </Group>
  );
}
