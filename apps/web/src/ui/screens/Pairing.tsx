import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useConnection, useProfile, useServices } from '../context';
import { errorCode, friendlyError } from '../errors';
import { Icon, Logo } from '../components/Icon';
import { useToast } from '../components/Toast';
import { extractCode, pickPairingCode } from '../qr/code';
import { scanImageFile } from '../qr/photo';
import { downloadBlob, QR_PNG_NAME, qrPngBlob, qrSvgDataUrl } from '../qr/render';
import { FOREIGN_QR_MESSAGE, QrScanner } from '../qr/Scanner';

export { extractCode };

type Mode = 'choose' | 'show' | 'join';

export const SHARE_WARNING =
  'Anyone with this code can pair with you until your partner joins. Share it only with your partner, preferably in person, and delete it from chats afterwards.';

export function Pairing({ onDone }: { onDone: () => void }) {
  const profile = useProfile();
  const connection = useConnection();
  const [mode, setMode] = useState<Mode>('choose');
  const [started, setStarted] = useState(false);
  // The partner device we already knew when this pairing attempt started (e.g. after "Unpair").
  // Only a live connection, or hearing from a *different* device, counts as success.
  const [knownPartner, setKnownPartner] = useState<string | undefined>(undefined);
  const success =
    started &&
    !!profile?.paired &&
    (connection === 'connected' || (!!profile.partnerDeviceId && profile.partnerDeviceId !== knownPartner));
  const markStarted = () => {
    setKnownPartner(profile?.partnerDeviceId);
    setStarted(true);
  };
  const back = () => {
    setStarted(false);
    setMode('choose');
  };

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(onDone, 1400);
    return () => clearTimeout(t);
  }, [success, onDone]);

  if (success) {
    return (
      <div className="flow">
        <div className="flow-inner center">
          <div className="success-burst" aria-hidden="true">
            🎉
          </div>
          <h1>You're paired!</h1>
          <p className="lead">{profile?.partnerName ? `Say hi to ${profile.partnerName}.` : 'Connected to your partner.'}</p>
          <button type="button" className="btn btn-primary btn-block" onClick={onDone}>
            Start chatting
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flow">
      <div className="flow-inner">
        {mode === 'choose' && (
          <>
            <div className="hero compact">
              <Logo size={56} />
              <h1>Pair with your partner</h1>
              <p className="lead">One of you shows a code, the other one scans it. You only do this once.</p>
            </div>
            <div className="choice-list">
              <button type="button" className="choice" onClick={() => setMode('show')}>
                <span className="choice-icon" aria-hidden="true">
                  <Icon name="qr" size={28} />
                </span>
                <span className="choice-text">
                  <strong>Show my code</strong>
                  <span>I'm setting up first. My partner will scan it.</span>
                </span>
              </button>
              <button type="button" className="choice" onClick={() => setMode('join')}>
                <span className="choice-icon alt" aria-hidden="true">
                  <Icon name="camera" size={28} />
                </span>
                <span className="choice-text">
                  <strong>Join my partner</strong>
                  <span>Scan or type the code on their screen.</span>
                </span>
              </button>
            </div>
            <p className="fineprint">
              <Icon name="lock" size={14} /> The code is a secret key. It never leaves your two phones; the relay only sees a scrambled room id.
            </p>
          </>
        )}
        {mode === 'show' && <ShowCode onBack={back} onStarted={markStarted} onContinue={onDone} />}
        {mode === 'join' && <JoinPartner onBack={back} onStarted={markStarted} onContinue={onDone} started={started} />}
      </div>
    </div>
  );
}

function ConnectionStatus() {
  const connection = useConnection();
  const text =
    connection === 'connected'
      ? 'Connected!'
      : connection === 'waiting'
        ? 'Waiting for your partner…'
        : connection === 'connecting'
          ? 'Connecting to the relay…'
          : 'Not connected yet';
  return (
    <p className={`pair-status status-${connection}`} role="status" aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      {text}
    </p>
  );
}

function ShowCode({ onBack, onStarted, onContinue }: { onBack: () => void; onStarted: () => void; onContinue: () => void }) {
  const { pairing } = useServices();
  const profile = useProfile();
  const toast = useToast();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const existing = profile?.paired && !profile.partnerName ? profile.pairingCode : undefined;
    const p = existing ? Promise.resolve(existing) : pairing.createPairing();
    p.then(
      (c) => {
        setCode(c);
        onStarted();
      },
      (e) => setError(friendlyError(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The QR holds just the code (no URL), so any scanner app can read it too.
  const qr = useMemo(() => {
    if (!code) return null;
    try {
      return qrSvgDataUrl(code);
    } catch {
      return null;
    }
  }, [code]);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Code copied');
    } catch {
      toast.error("Couldn't copy. Select the code and copy it by hand.");
    }
  };

  const save = async () => {
    if (!code) return;
    setSaving(true);
    try {
      downloadBlob(await qrPngBlob(code), QR_PNG_NAME);
      toast.success('QR image saved');
    } catch {
      toast.error("Couldn't create the image here. Copy the code instead.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pair-panel" aria-labelledby="show-title">
      <button type="button" className="link-btn back" onClick={onBack}>
        <Icon name="back" size={18} /> Back
      </button>
      <h1 id="show-title">Your pairing code</h1>
      <p className="lead">On your partner's phone, open Meme Pals and choose “Join my partner”.</p>
      <div className="qr-card">
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : qr ? (
          <img className="qr" src={qr} alt={`QR code for pairing code ${code}`} width={264} height={264} />
        ) : (
          <div className="qr qr-loading">
            <span className="spinner" />
          </div>
        )}
        {code && (
          <>
            <code className="pair-code" aria-label="Pairing code">
              {code}
            </code>
            <div className="code-row">
              <button type="button" className="btn btn-soft btn-sm" onClick={copy}>
                <Icon name="copy" size={16} /> Copy
              </button>
              <button type="button" className="btn btn-soft btn-sm" onClick={save} disabled={saving}>
                <Icon name="download" size={16} /> Save QR image
              </button>
            </div>
            <p className="fineprint pair-warning">
              <Icon name="lock" size={14} /> {SHARE_WARNING}
            </p>
          </>
        )}
      </div>
      <ConnectionStatus />
      <p className="fineprint">Keep this screen open until your partner connects. Turning up the brightness helps the camera read it.</p>
      <button type="button" className="link-btn" onClick={onContinue} disabled={!code}>
        Continue anyway
      </button>
    </section>
  );
}

const PHOTO_NO_QR = 'Couldn’t find a QR code in that picture. Try a sharper photo or an uncropped screenshot, or type the code below.';
const PHOTO_FOREIGN = `${FOREIGN_QR_MESSAGE}. Pick the picture of your partner’s pairing code.`;
const PHOTO_UNREADABLE = 'That picture couldn’t be opened. Try another one, or type the code below.';

function JoinPartner({ onBack, onStarted, onContinue, started }: { onBack: () => void; onStarted: () => void; onContinue: () => void; started: boolean }) {
  const { pairing } = useServices();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  const submit = async (value: string) => {
    const c = extractCode(value);
    if (!c) {
      setError('Enter the code shown on your partner’s screen.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pairing.acceptPairing(c);
      onStarted();
    } catch (e) {
      setError(errorCode(e) === 'invalid-code' ? friendlyError(e) : friendlyError(e, "Couldn't join. Check the code and try again."));
    } finally {
      setBusy(false);
    }
  };

  /** A code read from the camera or a photo: show it, then join straight away. */
  const joinScanned = (c: string) => {
    setScanError(null);
    setCode(c);
    void submit(c);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(code);
  };

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setCode(extractCode(t));
    } catch {
      setError('Paste isn’t available here. Long-press the field and choose Paste.');
    }
  };

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so choosing the same picture again still fires a change
    if (!file) return;
    setScanError(null);
    setReadingPhoto(true);
    try {
      const { code: found, foreign } = pickPairingCode(await scanImageFile(file));
      if (found) joinScanned(found);
      else setScanError(foreign ? PHOTO_FOREIGN : PHOTO_NO_QR);
    } catch {
      setScanError(PHOTO_UNREADABLE);
    } finally {
      setReadingPhoto(false);
    }
  };

  return (
    <section className="pair-panel" aria-labelledby="join-title">
      <button type="button" className="link-btn back" onClick={onBack}>
        <Icon name="back" size={18} /> Back
      </button>
      <h1 id="join-title">Join your partner</h1>
      <p className="lead">Point your camera at the QR code on their screen, or type the code.</p>

      {started ? (
        <div className="card">
          <ConnectionStatus />
          <p className="fineprint">Your partner's app needs to be open too.</p>
          <button type="button" className="link-btn" onClick={onContinue}>
            Continue anyway
          </button>
        </div>
      ) : (
        <>
          {scanning ? (
            <QrScanner
              onCode={(c) => {
                setScanning(false);
                joinScanned(c);
              }}
              onCancel={() => setScanning(false)}
              onProblem={(msg) => {
                setScanning(false);
                setScanError(msg);
              }}
            />
          ) : (
            <div className="scan-actions">
              <button
                type="button"
                className="btn btn-soft btn-block btn-lg"
                onClick={() => {
                  setScanError(null);
                  setScanning(true);
                }}
                disabled={busy || readingPhoto}
              >
                <Icon name="camera" /> Scan QR code
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => photoInput.current?.click()}
                disabled={busy || readingPhoto}
                aria-describedby="photo-hint"
              >
                <Icon name="image" size={18} /> {readingPhoto ? 'Reading the photo…' : 'Choose a photo of the code'}
              </button>
              {/* No `capture` attribute: people need to pick a screenshot from the gallery, not only take a photo. */}
              <input
                ref={photoInput}
                type="file"
                accept="image/*"
                className="visually-hidden-input"
                tabIndex={-1}
                aria-hidden="true"
                data-testid="qr-photo-input"
                onChange={(e) => void onPhoto(e)}
              />
              <p id="photo-hint" className="hint">
                Pairing from afar? Your partner can save their QR image and send it to you.
              </p>
            </div>
          )}
          {scanError && (
            <p className="field-error scan-error" role="alert">
              {scanError}
            </p>
          )}

          <div className="divider-text">
            <span>or type it</span>
          </div>

          <form className="card form" onSubmit={onSubmit} noValidate>
            <label htmlFor="pair-code-input" className="label">
              Pairing code
            </label>
            <div className="input-with-btn">
              <input
                id="pair-code-input"
                className="input mono"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX-…"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={!!error}
                aria-describedby={error ? 'pair-error' : undefined}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={paste}>
                Paste
              </button>
            </div>
            {error && (
              <p id="pair-error" className="field-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || !code.trim()}>
              {busy ? 'Joining…' : 'Join'}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
