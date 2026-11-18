import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useConnection, useProfile, useServices } from '../context';
import { errorCode, friendlyError } from '../errors';
import { Icon, Logo } from '../components/Icon';
import { useToast } from '../components/Toast';

type Mode = 'choose' | 'show' | 'join';

const CODE_IN_TEXT = /[0-9A-Za-z]{4}(?:[-\s][0-9A-Za-z]{4}){7}/;

/** A scanned QR may contain just the code, or a link that embeds it. */
export function extractCode(raw: string): string {
  const m = CODE_IN_TEXT.exec(raw);
  return (m ? m[0] : raw).trim();
}

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
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!code) return;
    let alive = true;
    QRCode.toString(code, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#1f1630', light: '#ffffff' } }).then(
      (svg) => alive && setQr('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)),
      () => alive && setQr(null),
    );
    return () => {
      alive = false;
    };
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
          <img className="qr" src={qr} alt={`QR code for pairing code ${code}`} width={232} height={232} />
        ) : (
          <div className="qr qr-loading">
            <span className="spinner" />
          </div>
        )}
        {code && (
          <div className="code-row">
            <code className="pair-code" aria-label="Pairing code">
              {code}
            </code>
            <button type="button" className="btn btn-soft btn-sm" onClick={copy}>
              <Icon name="copy" size={16} /> Copy
            </button>
          </div>
        )}
      </div>
      <ConnectionStatus />
      <p className="fineprint">Keep this screen open until your partner connects. Only share the code with them.</p>
      <button type="button" className="link-btn" onClick={onContinue} disabled={!code}>
        Continue anyway
      </button>
    </section>
  );
}

function JoinPartner({ onBack, onStarted, onContinue, started }: { onBack: () => void; onStarted: () => void; onContinue: () => void; started: boolean }) {
  const { pairing } = useServices();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

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
              onResult={(text) => {
                setScanning(false);
                const c = extractCode(text);
                setCode(c);
                void submit(c);
              }}
              onCancel={() => setScanning(false)}
              onError={(msg) => {
                setScanning(false);
                setError(msg);
              }}
            />
          ) : (
            <button type="button" className="btn btn-soft btn-block btn-lg" onClick={() => (setError(null), setScanning(true))}>
              <Icon name="camera" /> Scan QR code
            </button>
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

function cameraErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was denied. You can allow it in your browser settings, or just type the code below.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found on this device. Type the code below instead.';
  if (name === 'NotReadableError') return 'The camera is busy in another app. Close it and try again, or type the code.';
  return "Couldn't start the camera. Type the code below instead.";
}

export function QrScanner({ onResult, onCancel, onError }: { onResult: (text: string) => void; onCancel: () => void; onError: (msg: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const cb = useRef({ onResult, onError });
  cb.current = { onResult, onError };

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        cb.current.onError('The camera needs a secure (https) connection in this browser. Type the code below instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        if (!stopped) cb.current.onError(cameraErrorMessage(e));
        return;
      }
      if (stopped || !video.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const v = video.current;
      v.srcObject = stream;
      try {
        await v.play();
      } catch {
        /* autoplay quirks; frames still arrive */
      }
      setReady(true);
      const jsQR = (await import('jsqr')).default;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let last = 0;
      const tick = (now: number) => {
        if (stopped) return;
        raf = requestAnimationFrame(tick);
        if (!ctx || now - last < 120 || v.readyState < 2 || !v.videoWidth) return;
        last = now;
        const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
        const w = Math.round(v.videoWidth * k);
        const h = Math.round(v.videoHeight * k);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const found = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (found?.data) {
          stop();
          cb.current.onResult(found.data);
        }
      };
      raf = requestAnimationFrame(tick);
    })();
    return stop;
  }, []);

  return (
    <div className="scanner">
      <video ref={video} className="scanner-video" playsInline muted aria-label="Camera preview" />
      <div className="scanner-frame" aria-hidden="true" />
      {!ready && (
        <div className="scanner-wait">
          <span className="spinner" /> Starting camera…
        </div>
      )}
      <button type="button" className="btn btn-glass scanner-cancel" onClick={onCancel}>
        <Icon name="keyboard" size={18} /> Type instead
      </button>
    </div>
  );
}
