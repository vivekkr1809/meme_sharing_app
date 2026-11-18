import { useId, useRef, useState, type FormEvent, type Ref } from 'react';
import { useReadable } from '../../lib/store';
import { useServices } from '../context';
import { errorCode, friendlyError } from '../errors';
import { Segmented } from '../components/Controls';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { rememberPasscodeKind } from './Lock';
import './Lock.css';

const AUTO_LOCK_CHOICES = [
  { value: '0', label: 'Immediately' },
  { value: '1', label: '1 min' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '60', label: '1 hour' },
];

/** Settings → "Passcode lock": turn on/off, change, auto-lock delay, lock now. */
export function PasscodeSection() {
  const { lock } = useServices();
  const state = useReadable(lock.state);
  const minutes = useReadable(lock.autoLockMinutes);
  const toast = useToast();
  const [dialog, setDialog] = useState<'enable' | 'change' | 'disable' | null>(null);
  const on = state !== 'disabled';
  const choices = AUTO_LOCK_CHOICES.some((c) => c.value === String(minutes))
    ? AUTO_LOCK_CHOICES
    : [...AUTO_LOCK_CHOICES, { value: String(minutes), label: `${minutes} min` }];

  const setMinutes = async (v: string) => {
    try {
      await lock.setAutoLockMinutes(Number(v));
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  return (
    <section className="group" aria-labelledby="g-lock">
      <h2 className="group-title" id="g-lock">
        Passcode lock
      </h2>
      <div className="card">
        <div className="row-info lock-status">
          <Icon name="lock" size={18} />
          <span>{on ? 'On. Your chats and memes are encrypted on this phone.' : 'Off'}</span>
        </div>
        {!on ? (
          <>
            <p className="hint">
              Ask for a passcode when Meme Pals opens, and encrypt your messages, memes, names and pairing key on this phone. If you forget the passcode, the only way back in is to
              wipe this phone.
            </p>
            <button type="button" className="btn btn-soft" onClick={() => setDialog('enable')}>
              <Icon name="lock" size={18} /> Turn on passcode lock
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <span className="label">Lock after the app is in the background for</span>
              <Segmented<string> label="Auto-lock" size="sm" value={String(minutes)} onChange={(v) => void setMinutes(v)} options={choices} />
            </div>
            <p className="hint">While it's locked your phone doesn't sync. Your partner's new messages arrive after you unlock.</p>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={() => void lock.lockNow()}>
                <Icon name="lock" size={18} /> Lock now
              </button>
              <button type="button" className="btn btn-soft" onClick={() => setDialog('change')}>
                Change passcode
              </button>
              <button type="button" className="btn btn-danger-soft" onClick={() => setDialog('disable')}>
                Turn off
              </button>
            </div>
          </>
        )}
      </div>
      {dialog === 'enable' && <EnableDialog onClose={() => setDialog(null)} onDone={() => toast.success('Passcode lock is on')} />}
      {dialog === 'change' && <ChangeDialog onClose={() => setDialog(null)} onDone={() => toast.success('Passcode changed')} />}
      {dialog === 'disable' && <DisableDialog onClose={() => setDialog(null)} onDone={() => toast.success('Passcode lock is off')} />}
    </section>
  );
}

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

function PasscodeField({
  label,
  value,
  onChange,
  error,
  autoComplete,
  autoFocus,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  autoComplete: 'new-password' | 'current-password';
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        className="input"
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
        {...(autoFocus ? { 'data-autofocus': true } : {})}
      />
      {error && (
        <p id={`${id}-err`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type Errors = { current?: string; next?: string; confirm?: string; form?: string };

/** Shared checks for a new passcode typed twice. */
function checkNew(next: string, confirm: string): Errors | null {
  if ([...next].length < 4) return { next: 'Use at least 4 characters. 6 or more digits, or a short phrase, is much safer.' };
  if (next !== confirm) return { confirm: "The passcodes don't match." };
  return null;
}

function busyLabel(busy: boolean, idle: string, working: string) {
  return busy ? (
    <>
      <span className="spinner sm" /> {working}
    </>
  ) : (
    idle
  );
}

function EnableDialog({ onClose, onDone }: DialogProps) {
  const { lock } = useServices();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const bad = checkNew(next, confirm);
    setErrors(bad ?? {});
    if (bad) return;
    setBusy(true);
    try {
      await lock.enable(next);
      rememberPasscodeKind(next);
      onDone();
      onClose();
    } catch (err) {
      setBusy(false);
      setErrors({ form: friendlyError(err) });
    }
  };

  return (
    <Modal label="Turn on passcode lock" onClose={() => !busy && onClose()} variant="dialog">
      <form onSubmit={submit} noValidate>
        <h2 className="dialog-title">Turn on passcode lock</h2>
        <div className="dialog-body form">
          <p>
            Use <strong>6 or more digits</strong>, or better, a short passphrase. Your data on this phone is encrypted with it.
          </p>
          <p className="lock-warning">
            <strong>If you forget it, there is no reset.</strong> The only way back in is to wipe this phone (a backup file and your partner's copy still help).
          </p>
          <PasscodeField label="New passcode" value={next} onChange={setNext} error={errors.next} autoComplete="new-password" autoFocus />
          <PasscodeField label="Type it again" value={confirm} onChange={setConfirm} error={errors.confirm} autoComplete="new-password" />
          {errors.form && (
            <p className="field-error" role="alert">
              {errors.form}
            </p>
          )}
          {busy && <p className="hint">Encrypting your chats and memes…</p>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busyLabel(busy, 'Turn on', 'Turning on…')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ChangeDialog({ onClose, onDone }: DialogProps) {
  const { lock } = useServices();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const bad = !current ? { current: 'Enter your current passcode.' } : checkNew(next, confirm);
    setErrors(bad ?? {});
    if (bad) return;
    setBusy(true);
    try {
      await lock.change(current, next);
      rememberPasscodeKind(next);
      onDone();
      onClose();
    } catch (err) {
      setBusy(false);
      if (errorCode(err) === 'wrong-passcode') {
        setErrors({ current: friendlyError(err) });
        setCurrent('');
        currentRef.current?.focus();
      } else setErrors({ form: friendlyError(err) });
    }
  };

  return (
    <Modal label="Change passcode" onClose={() => !busy && onClose()} variant="dialog">
      <form onSubmit={submit} noValidate>
        <h2 className="dialog-title">Change passcode</h2>
        <div className="dialog-body form">
          <PasscodeField label="Current passcode" value={current} onChange={setCurrent} error={errors.current} autoComplete="current-password" autoFocus inputRef={currentRef} />
          <PasscodeField label="New passcode" value={next} onChange={setNext} error={errors.next} autoComplete="new-password" />
          <PasscodeField label="Type the new one again" value={confirm} onChange={setConfirm} error={errors.confirm} autoComplete="new-password" />
          {errors.form && (
            <p className="field-error" role="alert">
              {errors.form}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busyLabel(busy, 'Change', 'Changing…')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DisableDialog({ onClose, onDone }: DialogProps) {
  const { lock } = useServices();
  const [current, setCurrent] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!current) {
      setErrors({ current: 'Enter your current passcode.' });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await lock.disable(current);
      rememberPasscodeKind(null);
      onDone();
      onClose();
    } catch (err) {
      setBusy(false);
      setCurrent('');
      setErrors(errorCode(err) === 'wrong-passcode' ? { current: friendlyError(err) } : { form: friendlyError(err) });
    }
  };

  return (
    <Modal label="Turn off passcode lock" onClose={() => !busy && onClose()} variant="dialog">
      <form onSubmit={submit} noValidate>
        <h2 className="dialog-title">Turn off passcode lock?</h2>
        <div className="dialog-body form">
          <p>Anyone who can open this phone will be able to open Meme Pals, and your data here will no longer be encrypted.</p>
          <PasscodeField label="Current passcode" value={current} onChange={setCurrent} error={errors.current} autoComplete="current-password" autoFocus />
          {errors.form && (
            <p className="field-error" role="alert">
              {errors.form}
            </p>
          )}
          {busy && <p className="hint">Decrypting your chats and memes…</p>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy}>
            {busyLabel(busy, 'Turn off', 'Turning off…')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
