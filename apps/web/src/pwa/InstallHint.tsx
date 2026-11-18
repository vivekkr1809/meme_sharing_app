import { useState } from 'react';
import { useReadable } from '../lib/store';
import { Icon } from '../ui/components/Icon';
import { appInstalled, dismissHint, hintDismissed, installPrompt, isIos, isStandalone, promptInstall } from './install';

function IosSteps() {
  return (
    <ol className="install-steps">
      <li>
        Tap the <strong>Share</strong> button{' '}
        <span className="inline-icon" aria-label="Share icon">
          <Icon name="share" size={16} />
        </span>{' '}
        in Safari's toolbar.
      </li>
      <li>
        Scroll down and choose <strong>Add to Home Screen</strong>.
      </li>
      <li>
        Tap <strong>Add</strong>, then open Meme Pals from your Home Screen.
      </li>
    </ol>
  );
}

/** Dismissible banner shown in the main shell until installed. */
export function InstallBanner() {
  const prompt = useReadable(installPrompt);
  const installed = useReadable(appInstalled);
  const [hidden, setHidden] = useState(hintDismissed);
  const [showSteps, setShowSteps] = useState(false);
  const ios = isIos();
  if (hidden || installed || isStandalone() || (!prompt && !ios)) return null;

  const close = () => {
    dismissHint();
    setHidden(true);
  };

  return (
    <div className="install-banner" role="region" aria-label="Install Meme Pals">
      <div className="install-banner-row">
        <span className="install-emoji" aria-hidden="true">
          📲
        </span>
        <p>
          <strong>Add Meme Pals to your Home Screen</strong>
        </p>
        {prompt ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void promptInstall().then((ok) => ok && close())}>
            Install
          </button>
        ) : (
          <button type="button" className="btn btn-soft btn-sm" onClick={() => setShowSteps((v) => !v)} aria-expanded={showSteps}>
            How?
          </button>
        )}
        <button type="button" className="icon-btn sm" aria-label="Dismiss install hint" onClick={close}>
          <Icon name="close" size={16} />
        </button>
      </div>
      {showSteps && (
        <>
          <p className="hint">It opens full-screen like an app, and your history is safer from the browser's storage cleanup.</p>
          <IosSteps />
        </>
      )}
    </div>
  );
}

/** Always-available instructions in Settings. */
export function InstallCard() {
  const prompt = useReadable(installPrompt);
  const installed = useReadable(appInstalled);
  const standalone = isStandalone();
  return (
    <section className="group" aria-labelledby="g-install">
      <h2 className="group-title" id="g-install">
        Install
      </h2>
      <div className="card">
        {standalone || installed ? (
          <p className="row-info">
            <Icon name="check" size={18} /> Meme Pals is installed on this device.
          </p>
        ) : prompt ? (
          <div className="install-card-row">
            <p className="hint">Install Meme Pals so it opens full-screen and works offline.</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void promptInstall()}>
              Install app
            </button>
          </div>
        ) : isIos() ? (
          <>
            <p className="hint">On iPhone and iPad, install from Safari:</p>
            <IosSteps />
          </>
        ) : (
          <>
            <p className="hint">Use your browser menu to install:</p>
            <ul className="install-steps">
              <li>
                <strong>iPhone / iPad (Safari):</strong> Share <Icon name="share" size={14} /> → Add to Home Screen
              </li>
              <li>
                <strong>Android (Chrome):</strong> ⋮ menu → Install app
              </li>
              <li>
                <strong>Desktop (Chrome/Edge):</strong> install icon in the address bar
              </li>
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
