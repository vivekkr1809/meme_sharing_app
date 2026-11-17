import type { ConnectionState } from '@memes/shared';
import { Emitter, toHttpUrl } from '@memes/shared';
import type { AppServices, CreateTransport, Transport, TransportEvents, TransportOptions } from '../contracts';
import { createMemeServices } from '../memes';
import { createTransport } from '../p2p';
import { createDataServices } from '../sync';

/** Used when the relay's /config can't be reached (e.g. app hosted separately from the relay). */
export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

/** GET <relay>/config → iceServers (STUN, plus TURN if the relay operator configured one). */
export async function fetchIceServers(relayUrl: string, fetchImpl: typeof fetch = fetch): Promise<RTCIceServer[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const url = relayUrl ? toHttpUrl(relayUrl, '/config') : '/config';
    const res = await fetchImpl(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`config ${res.status}`);
    const body = (await res.json()) as { iceServers?: unknown };
    const list = Array.isArray(body.iceServers) ? body.iceServers : [];
    const valid = list.filter(
      (s): s is RTCIceServer =>
        !!s && (typeof s.urls === 'string' || (Array.isArray(s.urls) && s.urls.every((u: unknown) => typeof u === 'string'))),
    );
    return valid.length ? valid : FALLBACK_ICE_SERVERS;
  } catch {
    return FALLBACK_ICE_SERVERS;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps a CreateTransport so ICE servers are fetched from the *current* relay's
 * /config right before connecting. The data layer recreates the transport when
 * the relay URL changes, so a custom relay automatically brings its own TURN config.
 */
export function withRelayIceConfig(inner: CreateTransport, fetchImpl?: typeof fetch): CreateTransport {
  return (opts: TransportOptions): Transport => {
    const emitter = new Emitter<TransportEvents & Record<string, unknown>>();
    let real: Transport | null = null;
    let wanted = false;
    let preparing: Promise<void> | null = null;
    let state: ConnectionState = 'idle';
    const setState = (s: ConnectionState) => {
      if (s !== state) emitter.emit('state', (state = s));
    };

    const prepare = () =>
      (preparing ??= (async () => {
        const iceServers = opts.iceServers?.length ? opts.iceServers : await fetchIceServers(opts.relayUrl, fetchImpl);
        real = inner({ ...opts, iceServers });
        real.on('state', setState);
        real.on('frame', (f) => emitter.emit('frame', f));
        real.on('blob', (b) => emitter.emit('blob', b));
      })());

    return {
      get state() {
        return state;
      },
      start() {
        wanted = true;
        setState(real?.state === 'connected' ? 'connected' : 'connecting');
        void prepare().then(() => {
          if (wanted) real!.start();
        });
      },
      stop() {
        wanted = false;
        real?.stop();
        setState('idle');
      },
      send: (frame) => real?.send(frame) ?? false,
      sendBlob: (memeId, mime, data) =>
        real ? real.sendBlob(memeId, mime, data) : Promise.reject(new Error('not connected')),
      on: (event, cb) => emitter.on(event, cb as (p: unknown) => void),
    };
  };
}

/** Compose the real app: local DB + sync over WebRTC + meme sources. */
export async function createAppServices(opts: { dbName?: string } = {}): Promise<AppServices> {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost:8787';
  const data = await createDataServices({
    dbName: opts.dbName,
    createTransport: withRelayIceConfig(createTransport),
    defaultRelayUrl: origin,
  });
  // '' means "same origin": the meme client then uses relative /proxy/... paths.
  const memes = createMemeServices({ getRelayUrl: () => data.settings.settings.get().relayUrl });
  return { ...data, ...memes };
}
