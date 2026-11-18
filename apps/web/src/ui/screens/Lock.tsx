import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useReadable } from '../../lib/store';
import { useServices } from '../context';
import { errorCode, friendlyError } from '../errors';
import { Icon, Logo } from '../components/Icon';
import { Modal } from '../components/Modal';
import './Lock.css';

/**
 * Whether the passcode is all digits, so the lock screen can offer the number pad. Stored in
 * localStorage when the passcode is set: it reveals only "digits or not", never the passcode.
 */
const NUMERIC_KEY = 'meme-pals:passcode-numeric';

export function isNumericPasscode(p: string): boolean {
  return /^[0-9]+$/.test(p);
}

export function rememberPasscodeKind(passcode: string | null): void {
  try {
    if (passcode === null) localStorage.removeItem(NUMERIC_KEY);
    else localStorage.setItem(NUMERIC_KEY, isNumericPasscode(passcode) ? '1' : '0');
  } catch {
    /* storage unavailable: the lock screen falls back to a text field */
  }
}

function passcodeIsNumeric(): boolean {
  try {
    return localStorage.getItem(NUMERIC_KEY) === '1';
  } catch {
    return false;
  }
}

/** "0:42", "4:05", "1:00:00". */
export function formatWait(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Shown instead of the app whenever the passcode lock is closed. */
export function LockScreen() {
  const { lock } = useServices();
  const retryMs = useReadable(lock.retryAfterMs);
  const [numeric, setNumeric] = useState(passcodeIsNumeric);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wiping, setWiping] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const waiting = retryMs > 0;

  useEffect(() => {
    if (!waiting && !busy) input.current?.focus({ preventScroll: true });
  }, [waiting, busy, numeric]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || waiting) return;
    if (!code) {
      setError('Enter your passcode.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await lock.unlock(code);
    } catch (err) {
      const c = errorCode(err);
      setError(c === 'too-many-attempts' ? null : friendlyError(err));
      setCode('');
      setBusy(false);
    }
  };

  return (
    <div className="flow lock-screen">
      <div className="flow-inner center">
        <div className="hero compact">
          <Logo size={80} />
          <h1>Meme Pals is locked</h1>
          <p className="lead">Enter your passcode to open your chats.</p>
        </div>

        <form className="card form lock-form" onSubmit={submit} noValidate>
          <label htmlFor="lock-passcode" className="label">
            Passcode
          </label>
          <input
            ref={input}
            id="lock-passcode"
            className={`input lock-input ${numeric ? 'is-numeric' : ''}`}
            type="password"
            inputMode={numeric ? 'numeric' : 'text'}
            pattern={numeric ? '[0-9]*' : undefined}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={busy}
            aria-invalid={!!error}
            aria-describedby={error ? 'lock-error' : waiting ? 'lock-wait' : undefined}
          />
          {error && (
            <p id="lock-error" className="field-error" role="alert">
              {error}
            </p>
          )}
          {waiting && (
            <p id="lock-wait" className="lock-wait" role="status">
              Too many tries. Try again in <strong>{formatWait(retryMs)}</strong>
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || waiting}>
            {busy ? <span className="spinner sm" /> : <Icon name="lock" size={18} />} {busy ? 'Unlocking…' : 'Unlock'}
          </button>
          <button type="button" className="link-btn small" onClick={() => setNumeric(!numeric)}>
            {numeric ? 'Use the keyboard' : 'Use the number pad'}
          </button>
        </form>

        <button type="button" className="link-btn small lock-forgot" onClick={() => setWiping(true)}>
          Forgot passcode? Wipe this device
        </button>
      </div>
      {wiping && <WipeDialog onClose={() => setWiping(false)} />}
    </div>
  );
}

const WIPE_WORD = 'WIPE';

/** Strong confirmation: the user must type WIPE. There is no other way back without the passcode. */
function WipeDialog({ onClose }: { onClose: () => void }) {
  const { pairing } = useServices();
  const id = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed.trim().toUpperCase() === WIPE_WORD;

  const wipe = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    try {
      await pairing.wipe();
      rememberPasscodeKind(null);
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <Modal label="Wipe this device?" onClose={onClose} variant="dialog" role="alertdialog">
      <form onSubmit={wipe} noValidate>
        <h2 className="dialog-title">Wipe this device?</h2>
        <div className="dialog-body">
          <p>
            Without the passcode nothing on this phone can be opened. Wiping deletes <strong>every message, meme and setting</strong> here and you start over (pair again; restore a
            backup file if you have one). Your partner's phone keeps its copy.
          </p>
          <label className="label" htmlFor={`${id}-confirm`}>
            Type {WIPE_WORD} to confirm
          </label>
          <input
            id={`${id}-confirm`}
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            data-autofocus
          />
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={!ok || busy}>
            <Icon name="trash" size={18} /> {busy ? 'Wiping…' : 'Wipe everything'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
