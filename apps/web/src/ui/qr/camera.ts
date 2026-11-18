import { pickPairingCode } from './code';
import { cameraRegion, createQrDetector, type QrDetector } from './detector';

/**
 * The camera side of QR scanning: getting a stream, the throttled frame loop, and turning
 * failures into messages people can act on. Framework-free; Scanner.tsx wires it to React.
 */

export type CameraProblem = 'insecure' | 'unsupported' | 'denied' | 'no-camera' | 'in-use' | 'stopped' | 'other';

const MESSAGES: Record<CameraProblem, string> = {
  insecure:
    'The camera only works over a secure (https://) connection, and this page was opened over http. Open the app’s https address, or choose a photo of the code or type it below.',
  unsupported: 'This browser can’t use the camera here. Choose a photo of the code or type it below.',
  denied: 'Camera access is blocked. Allow the camera for this site in your browser settings, or choose a photo of the code or type it below.',
  'no-camera': 'No camera found on this device. Choose a photo of the code or type it below.',
  'in-use': 'The camera is being used by another app. Close that app and try again, or type the code below.',
  stopped: 'The camera stopped. Try again, or type the code below.',
  other: 'Couldn’t start the camera. Try again, or type the code below.',
};

export function cameraMessage(problem: CameraProblem): string {
  return MESSAGES[problem];
}

/** Map a getUserMedia rejection (DOMException name) to a problem. */
export function classifyCameraError(e: unknown): CameraProblem {
  const name = (e as { name?: unknown } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'no-camera';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use';
    default:
      return 'other';
  }
}

/** Why the camera can't even be asked for, if so. */
export function cameraPrecheck(scope: { isSecureContext?: boolean; navigator?: Navigator } = globalThis): CameraProblem | null {
  if (scope.isSecureContext === false) return 'insecure';
  if (typeof scope.navigator?.mediaDevices?.getUserMedia !== 'function') return 'unsupported';
  return null;
}

/** Rear camera, around 720p: enough detail for a phone screen at arm's length, cheap to process. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

export async function openCamera(media: MediaDevices = navigator.mediaDevices): Promise<MediaStream> {
  try {
    return await media.getUserMedia(CAMERA_CONSTRAINTS);
  } catch (e) {
    // Some older browsers choke on the constraint syntax itself; any camera is better than none.
    const name = (e as { name?: string })?.name;
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError' || name === 'TypeError') {
      return media.getUserMedia({ video: true, audio: false });
    }
    throw e;
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  });
}

/** Minimum time between processed frames: about 10 fps. */
export const FRAME_INTERVAL_MS = 100;

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Call `onFrame` for at most one frame per `intervalMs`, never overlapping (a slow decode
 * just skips frames). Uses requestVideoFrameCallback when available, so frames are only
 * processed when the camera delivers a new one; rAF otherwise.
 */
export function startFrameLoop(video: HTMLVideoElement, onFrame: (n: number) => Promise<void> | void, intervalMs = FRAME_INTERVAL_MS): { cancel(): void } {
  const v = video as VideoWithRvfc;
  const rvfc = typeof v.requestVideoFrameCallback === 'function';
  let cancelled = false;
  let busy = false;
  let last = -Infinity;
  let n = 0;
  let handle = 0;
  const schedule = () => {
    if (cancelled) return;
    handle = rvfc ? v.requestVideoFrameCallback!(step) : requestAnimationFrame(step);
  };
  const step = (now: number) => {
    if (cancelled) return;
    if (!busy && now - last >= intervalMs && video.readyState >= 2 && video.videoWidth > 0) {
      last = now;
      busy = true;
      Promise.resolve()
        .then(() => onFrame(n++))
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }
    schedule();
  };
  schedule();
  return {
    cancel() {
      cancelled = true;
      if (rvfc) v.cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);
    },
  };
}

export interface ScanHandlers {
  /** The camera is running and frames are being scanned. */
  onLive(): void;
  /** A valid Meme Pals code (canonical form). The camera is already stopped. */
  onCode(code: string): void;
  /** A QR code was read but it isn't a Meme Pals code. Scanning continues. */
  onForeign(): void;
  /** The camera couldn't start or stopped by itself. The camera is already stopped. */
  onProblem(problem: CameraProblem): void;
}

export interface ScanDeps {
  media?: MediaDevices;
  detector?: () => Promise<QrDetector>;
  precheck?: () => CameraProblem | null;
}

export function vibrate(ms = 60): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
}

/** Start the camera on `video` and scan until a code is found or `stop()` is called. */
export function startScanSession(video: HTMLVideoElement, h: ScanHandlers, deps: ScanDeps = {}): { stop(): void } {
  let stopped = false;
  let stream: MediaStream | null = null;
  let loop: { cancel(): void } | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    loop?.cancel();
    stopStream(stream);
    stream = null;
    try {
      video.pause();
    } catch {
      /* jsdom */
    }
    video.srcObject = null;
  };
  const fail = (p: CameraProblem) => {
    if (stopped) return;
    stop();
    h.onProblem(p);
  };

  void (async () => {
    const pre = (deps.precheck ?? cameraPrecheck)();
    if (pre) return fail(pre);
    let s: MediaStream;
    try {
      s = await openCamera(deps.media ?? navigator.mediaDevices);
    } catch (e) {
      return fail(classifyCameraError(e));
    }
    if (stopped) return stopStream(s);
    stream = s;
    for (const t of s.getVideoTracks()) t.addEventListener('ended', () => fail('stopped'));
    video.srcObject = s;
    try {
      await video.play();
    } catch {
      /* autoplay quirks: the muted, inline preview still gets frames */
    }
    let detector: QrDetector;
    try {
      detector = await (deps.detector ?? createQrDetector)();
    } catch {
      return fail('unsupported');
    }
    if (stopped) return;
    h.onLive();
    loop = startFrameLoop(video, async (n) => {
      const w = video.videoWidth;
      const ht = video.videoHeight;
      const values = await detector.detect(video, w, ht, cameraRegion(detector.kind, w, ht, n));
      if (stopped || values.length === 0) return;
      const { code, foreign } = pickPairingCode(values);
      if (code) {
        stop();
        vibrate();
        h.onCode(code);
      } else if (foreign) {
        h.onForeign();
      }
    });
  })();

  return { stop };
}
