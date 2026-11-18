import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { cameraMessage, startScanSession, type CameraProblem } from './camera';

export const FOREIGN_QR_MESSAGE = 'That QR code isn’t a Meme Pals code';
const FOREIGN_MS = 2500;

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * Live camera preview that scans for a Meme Pals QR code. The camera is released on
 * success, on unmount, and while the tab is hidden (it restarts when the tab comes back).
 */
export function QrScanner({
  onCode,
  onCancel,
  onProblem,
}: {
  onCode: (code: string) => void;
  onCancel: () => void;
  onProblem: (message: string, problem: CameraProblem) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(isVisible);
  const [live, setLive] = useState(false);
  const [foreign, setForeign] = useState(false);
  const foreignTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cb = useRef({ onCode, onProblem });
  cb.current = { onCode, onProblem };

  useEffect(() => {
    const onChange = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
      clearTimeout(foreignTimer.current);
    };
  }, []);

  useEffect(() => {
    setLive(false);
    if (!visible || !video.current) return;
    const session = startScanSession(video.current, {
      onLive: () => setLive(true),
      onCode: (code) => cb.current.onCode(code),
      onForeign: () => {
        setForeign(true);
        clearTimeout(foreignTimer.current);
        foreignTimer.current = setTimeout(() => setForeign(false), FOREIGN_MS);
      },
      onProblem: (p) => cb.current.onProblem(cameraMessage(p), p),
    });
    return session.stop;
  }, [visible]);

  return (
    <div className="scanner">
      <video ref={video} className="scanner-video" playsInline muted autoPlay aria-label="Camera preview" />
      <div className="scanner-frame" aria-hidden="true" />
      {!live && (
        <div className="scanner-wait" role="status">
          {visible ? (
            <>
              <span className="spinner" /> Starting camera…
            </>
          ) : (
            'Camera paused'
          )}
        </div>
      )}
      {foreign && (
        <p className="scanner-note" role="status">
          {FOREIGN_QR_MESSAGE}
        </p>
      )}
      <button type="button" className="btn btn-glass scanner-cancel" onClick={onCancel}>
        <Icon name="keyboard" size={18} /> Type instead
      </button>
    </div>
  );
}
