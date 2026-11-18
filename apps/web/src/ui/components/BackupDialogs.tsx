import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { friendlyError } from '../errors';
import { Icon } from './Icon';
import { Modal } from './Modal';
import './BackupDialogs.css';

export const MIN_BACKUP_PASSWORD = 8;

export interface PasswordStrength {
  /** 0 too short · 1 weak · 2 okay · 3 strong */
  score: 0 | 1 | 2 | 3;
  label: string;
}

const OBVIOUS = /^(.)\1+$|password|passwort|123456|qwerty|azerty|abcdef|letmein|iloveyou|memepals/i;

/** A deliberately simple strength hint: length matters most, character variety helps a bit. */
export function passwordStrength(pw: string): PasswordStrength {
  const len = [...pw].length;
  if (len < MIN_BACKUP_PASSWORD) return { score: 0, label: 'Too short' };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let score: PasswordStrength['score'] = 1;
  if (len >= 12 || classes >= 3) score = 2;
  if (len >= 16 || (len >= 12 && classes >= 3)) score = 3;
  if (OBVIOUS.test(pw)) score = 1;
  return { score, label: (['Too short', 'Weak', 'Okay', 'Strong'] as const)[score] };
}

function Progress({ label }: { label: string }) {
  return (
    <div className="backup-progress" role="status">
      <div className="backup-progress-bar" role="progressbar" aria-label={label}>
        <span />
      </div>
      <p className="hint">{label}… This can take a moment for a big library.</p>
    </div>
  );
}

// ─── Export ─────────────────────────────────────────────────────────────────

export interface ExportBackupDialogProps {
  /** Encrypt and download. Rejections are shown inside the dialog. */
  onExport: (password: string) => Promise<void>;
  onClose: () => void;
}

export function ExportBackupDialog({ onExport, onClose }: ExportBackupDialogProps) {
  const id = useId();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<{ pw?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const strength = passwordStrength(pw);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if ([...pw].length < MIN_BACKUP_PASSWORD) {
      setErrors({ pw: `Use at least ${MIN_BACKUP_PASSWORD} characters.` });
      pwRef.current?.focus();
      return;
    }
    if (confirm !== pw) {
      setErrors({ confirm: "The passwords don't match." });
      confirmRef.current?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onExport(pw);
    } catch (err) {
      setBusy(false);
      setErrors({ form: friendlyError(err, "Couldn't create a backup.") });
    }
  };

  const close = () => {
    if (!busy) onClose();
  };
  const type = show ? 'text' : 'password';

  return (
    <Modal label="Export an encrypted backup" onClose={close} variant="dialog" className="backup-dialog">
      <h2 className="dialog-title">Export an encrypted backup</h2>
      <form className="form" onSubmit={submit} noValidate aria-busy={busy}>
        <p className="dialog-body">Choose a password to lock the backup file. You'll need it to restore the backup on any phone.</p>
        <p className="backup-warning" id={`${id}-warn`}>
          <Icon name="lock" size={18} />
          <span>
            <strong>If you forget this password, the backup can't be opened. We can't recover it.</strong>
          </span>
        </p>
        <div className="field">
          <label className="label" htmlFor={`${id}-pw`}>
            Backup password
          </label>
          <input
            ref={pwRef}
            id={`${id}-pw`}
            className="input"
            type={type}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            aria-invalid={!!errors.pw}
            aria-describedby={`${id}-strength${errors.pw ? ` ${id}-pw-err` : ''}`}
            data-autofocus
          />
          <div className={`pw-meter pw-score-${strength.score}`} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p className="hint" id={`${id}-strength`} aria-live="polite">
            {pw ? `Strength: ${strength.label}. ` : ''}At least {MIN_BACKUP_PASSWORD} characters. Longer is stronger: a few random words work well.
          </p>
          {errors.pw && (
            <p className="field-error" id={`${id}-pw-err`} role="alert">
              {errors.pw}
            </p>
          )}
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-confirm`}>
            Confirm password
          </label>
          <input
            ref={confirmRef}
            id={`${id}-confirm`}
            className="input"
            type={type}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            aria-invalid={!!errors.confirm}
            aria-describedby={errors.confirm ? `${id}-confirm-err` : undefined}
          />
          {errors.confirm && (
            <p className="field-error" id={`${id}-confirm-err`} role="alert">
              {errors.confirm}
            </p>
          )}
        </div>
        <label className="backup-show">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} disabled={busy} /> Show passwords
        </label>
        {busy && <Progress label="Encrypting your backup" />}
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner sm on-accent" aria-hidden="true" /> : <Icon name="download" size={18} />} Encrypt &amp; download
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Import ─────────────────────────────────────────────────────────────────

export interface ImportPasswordDialogProps {
  fileName: string;
  /** Decrypt and import. Reject with Error('wrong-password') to let the user try again. */
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}

export function ImportPasswordDialog({ fileName, onSubmit, onClose }: ImportPasswordDialogProps) {
  const id = useId();
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const ref = useRef<HTMLInputElement>(null);

  // After a failed attempt, put the cursor back in the (re-enabled) field with the text selected,
  // so the user can retype without picking the file again.
  useEffect(() => {
    if (!failures) return;
    ref.current?.focus();
    ref.current?.select();
  }, [failures]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!pw) {
      setError('Enter the backup password.');
      ref.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onSubmit(pw);
    } catch (err) {
      setBusy(false);
      setError(friendlyError(err, "Couldn't import that backup."));
      setFailures((n) => n + 1);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal label="Enter the backup password" onClose={close} variant="dialog" className="backup-dialog">
      <h2 className="dialog-title">Enter the backup password</h2>
      <form className="form" onSubmit={submit} noValidate aria-busy={busy}>
        <p className="dialog-body">
          <span className="backup-file-name">{fileName}</span> is encrypted. Enter the password you chose when you exported it.
        </p>
        <div className="field">
          <label className="label" htmlFor={`${id}-pw`}>
            Backup password
          </label>
          <input
            ref={ref}
            id={`${id}-pw`}
            className="input"
            type={show ? 'text' : 'password'}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-err` : undefined}
            data-autofocus
          />
          {error && (
            <p className="field-error" id={`${id}-err`} role="alert">
              {error}
            </p>
          )}
        </div>
        <label className="backup-show">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} disabled={busy} /> Show password
        </label>
        {busy && <Progress label="Unlocking your backup" />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner sm on-accent" aria-hidden="true" /> : <Icon name="upload" size={18} />} Unlock &amp; import
          </button>
        </div>
      </form>
    </Modal>
  );
}
