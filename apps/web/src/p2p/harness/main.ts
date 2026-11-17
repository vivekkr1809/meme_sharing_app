/**
 * Browser harness for the real-WebRTC integration test. Exposes `window.p2p`,
 * which Playwright drives via page.evaluate. Not part of the app bundle.
 */
import type { ConnectionState, ControlFrame } from '@memes/shared';
import { deriveKeys, sha256Hex } from '@memes/shared';
import type { Transport } from '../../contracts';
import type { TransportTuning } from '../index';
import { createTransport } from '../index';

export interface HarnessStartOptions {
  secretHex: string;
  relayUrl: string;
  deviceId: string;
  /** Join this room id instead of the one derived from the secret (attacker simulation). */
  roomIdOverride?: string;
  tuning?: Partial<Omit<TransportTuning, 'log'>>;
}

const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

let transport: Transport | null = null;
const states: ConnectionState[] = [];
const frames: ControlFrame[] = [];
const blobs: { memeId: string; mime: string; size: number; sha: string }[] = [];
const logs: string[] = [];
let roomId = '';

const api = {
  async start(o: HarnessStartOptions) {
    const keys = await deriveKeys(fromHex(o.secretHex));
    roomId = keys.roomId;
    if (o.roomIdOverride) keys.roomId = o.roomIdOverride;
    transport = createTransport({
      relayUrl: o.relayUrl,
      keys,
      deviceId: o.deviceId,
      tuning: { ...o.tuning, log: (m) => logs.push(`${Date.now() % 100000} ${m}`) },
    });
    transport.on('state', (s) => {
      states.push(s);
      document.getElementById('state')!.textContent = s;
    });
    transport.on('frame', (f) => frames.push(f));
    transport.on('blob', async (b) => {
      blobs.push({ memeId: b.memeId, mime: b.mime, size: b.data.byteLength, sha: await sha256Hex(b.data) });
    });
    transport.start();
    return roomId;
  },
  stop: () => transport?.stop(),
  restart: () => transport?.start(),
  state: () => transport?.state ?? 'idle',
  states: () => [...states],
  frames: () => [...frames],
  blobs: () => [...blobs],
  logs: () => [...logs],
  send: (f: ControlFrame) => transport?.send(f) ?? false,
  /** Bypass the transport and put raw text on the DataChannel (for invalid-frame tests). */
  sendRawText(s: string) {
    const session = (transport as unknown as { session?: { dc: RTCDataChannel } }).session;
    session?.dc.send(s);
  },
  /** Send `size` random bytes; resolves with the sha256 (= memeId) and timing. */
  async sendRandomBlob(size: number, opts: { stopAfterMs?: number } = {}) {
    const data = new Uint8Array(size);
    for (let off = 0; off < size; off += 65536) crypto.getRandomValues(data.subarray(off, Math.min(size, off + 65536)));
    const memeId = await sha256Hex(data);
    const t0 = performance.now();
    const p = transport!.sendBlob(memeId, 'image/png', data);
    if (opts.stopAfterMs !== undefined) setTimeout(() => transport!.stop(), opts.stopAfterMs);
    try {
      await p;
      return { memeId, ok: true, ms: performance.now() - t0 };
    } catch (err) {
      return { memeId, ok: false, error: String(err), ms: performance.now() - t0 };
    }
  },
};

(window as unknown as { p2p: typeof api }).p2p = api;
export type HarnessApi = typeof api;
