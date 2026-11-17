import { useState, type FormEvent } from 'react';
import { useServices } from '../context';
import { friendlyError } from '../errors';
import { Logo } from '../components/Icon';

export function Onboarding() {
  const { pairing } = useServices();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pairing.setDisplayName(name.trim());
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <div className="flow">
      <div className="flow-inner">
        <div className="hero">
          <Logo size={88} />
          <h1>Meme Pals</h1>
          <p className="lead">A tiny, private meme club for the two of you.</p>
        </div>

        <ul className="privacy-points" aria-label="How Meme Pals keeps things private">
          <li>
            <span aria-hidden="true">📱</span>
            <div>
              <strong>Lives on your phones</strong>
              <p>Chats, memes and settings are stored only on your two devices. No accounts, no cloud.</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">🔒</span>
            <div>
              <strong>Device to device</strong>
              <p>Messages travel directly between you over an encrypted connection.</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">🐸</span>
            <div>
              <strong>Memes from the internet</strong>
              <p>Browse Reddit and Imgflip, make your own, or share from your camera roll.</p>
            </div>
          </li>
        </ul>

        <form className="card form" onSubmit={submit} noValidate>
          <label htmlFor="display-name" className="label">
            What should your partner call you?
          </label>
          <input
            id="display-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={40}
            autoComplete="nickname"
            enterKeyHint="go"
            aria-invalid={!!error}
            aria-describedby={error ? 'name-error' : undefined}
            autoFocus
          />
          {error && (
            <p id="name-error" className="field-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
