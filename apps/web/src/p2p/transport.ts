import type { ConnectionState, ControlFrame, SignalData, SignedEnvelope } from '@memes/shared';
import {
  Emitter,
  MAX_MEME_BYTES,
  SIGNAL_MAX_SKEW_MS,
  openSignal,
  parseControlFrame,
  randomId,
  signSignal,
  toWsUrl,
} from '@memes/shared';
import type { Transport, TransportEvents, TransportOptions, Unsubscribe } from '../contracts';
import type { BackoffOptions } from './backoff';
import { withJitter } from './backoff';
import { chunkBlob, decodeBinary, encodeBinary, Reassembler } from './framing';
import { PeerSession, untagSdp } from './peer';
import { SignalingClient } from './signaling';

/**
 * Transport = relay signaling (signed) + one WebRTC DataChannel to the partner.
 *
 * Negotiation (see protocol.ts):
 *   - `peer-joined` → we offer now (after probing an already-open channel, see below).
 *   - `joined{peerPresent:true}` → wait for the partner's offer; offer ourselves only
 *     if none arrives within `offerFallbackMs`.
 *   - Glare (both offered): the side with the lexicographically smaller deviceId is
 *     "impolite" and keeps its offer; the other drops its own and answers.
 *   - A watchdog replaces any session that hasn't opened within `negotiateTimeoutMs`.
 *   - After DataChannel close / ICE failure, both re-offer if the partner is still in the
 *     room (impolite side quickly, polite side later as a fallback).
 *
 * Relay close code 4000 (same deviceId joined elsewhere) → we go idle instead of fighting.
 *
 * Relay drops never touch an open DataChannel: we stay `connected` and the signaling
 * client reconnects in the background. Because the partner sees `peer-left`/`peer-joined`
 * for such a drop, an open channel is kept on `peer-left`, and on `peer-joined` it is
 * probed with a ping first and only replaced if the probe fails (i.e. the partner reloaded).
 *
 * Security: every incoming envelope must pass openSignal (HMAC with the pairing auth key,
 * timestamp window, replay nonce) before anything reaches the RTCPeerConnection. The SDP
 * carries the DTLS fingerprint, so a relay can't substitute its own endpoint.
 */

export interface TransportTuning {
  heartbeatMs: number;
  connectTimeoutMs: number;
  roomFullDelayMs: number;
  backoff: BackoffOptions;
  /** Replace a session that hasn't opened in this long (doubles on repeat failures, ≤30 s). */
  negotiateTimeoutMs: number;
  /** After joining with the partner present, offer ourselves if no offer arrived by then. */
  offerFallbackMs: number;
  /** How long to wait for a DataChannel pong before declaring the channel dead. */
  probeTimeoutMs: number;
  reassemblyTimeoutMs: number;
  /** sendBlob pauses when dc.bufferedAmount exceeds this… */
  highWaterMark: number;
  /** …and resumes when it drops below this (bufferedAmountLowThreshold). */
  lowWaterMark: number;
  browserHooks: boolean;
  log: (msg: string) => void;
}

export type P2PTransportOptions = TransportOptions & { tuning?: Partial<TransportTuning> };

type Timer = ReturnType<typeof setTimeout>;

const DEFAULTS: Omit<TransportTuning, 'backoff' | 'browserHooks' | 'heartbeatMs'> = {
  connectTimeoutMs: 10_000,
  roomFullDelayMs: 30_000,
  negotiateTimeoutMs: 10_000,
  offerFallbackMs: 4_000,
  probeTimeoutMs: 3_000,
  reassemblyTimeoutMs: 60_000,
  highWaterMark: 1024 * 1024,
  lowWaterMark: 256 * 1024,
  log: () => {},
};

export class P2PTransport implements Transport {
  private emitter = new Emitter<TransportEvents & Record<string, unknown>>();
  private _state: ConnectionState = 'idle';
  private started = false;
  /** Bumped on stop(): async work from a previous run is discarded. */
  private epoch = 0;
  private signaling: SignalingClient | null = null;
  private unsubs: Unsubscribe[] = [];
  private joined = false;
  private peerInRoom = false;
  private session: PeerSession | null = null;
  private peerDeviceId: string | null = null;
  private negotiateFailures = 0;
  /** When the relay last told us the partner (re)joined. */
  private peerJoinedAt = 0;

  private readonly seenNonces = new Set<string>();
  private nonceLog: { nonce: string; ts: number }[] = [];
  private inQueue: Promise<void> = Promise.resolve();
  private outQueue: Promise<void> = Promise.resolve();

  private offerTimer: Timer | null = null;
  private watchdog: Timer | null = null;
  private probe: { n: number; timer: Timer } | null = null;

  private blobChain: Promise<void> = Promise.resolve();
  private waiters = new Set<(err: Error) => void>();
  private reassembler: Reassembler;
  private t: TransportTuning;

  constructor(private opts: P2PTransportOptions) {
    this.t = {
      ...DEFAULTS,
      backoff: {},
      browserHooks: typeof window !== 'undefined',
      heartbeatMs: 0,
      ...opts.tuning,
    };
    this.reassembler = new Reassembler({
      timeoutMs: this.t.reassemblyTimeoutMs,
      onComplete: (b) => this.emitter.emit('blob', b),
      onDrop: (id, reason) => this.t.log(`blob ${id} dropped: ${reason}`),
    });
  }

  get state(): ConnectionState {
    return this._state;
  }

  on<K extends keyof TransportEvents>(event: K, cb: (payload: TransportEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const sig = new SignalingClient({
      url: toWsUrl(this.opts.relayUrl),
      room: this.opts.keys.roomId,
      deviceId: this.opts.deviceId,
      WebSocketImpl: this.opts.WebSocketImpl,
      heartbeatMs: this.t.heartbeatMs || undefined,
      connectTimeoutMs: this.t.connectTimeoutMs,
      roomFullDelayMs: this.t.roomFullDelayMs,
      backoff: this.t.backoff,
      browserHooks: this.t.browserHooks,
    });
    this.signaling = sig;
    this.unsubs = [
      sig.on('status', () => this.recompute()),
      sig.on('joined', ({ peerPresent }) => this.onJoined(peerPresent)),
      sig.on('peer-joined', () => this.onPeerJoined()),
      sig.on('peer-left', () => this.onPeerLeft()),
      sig.on('signal', (env) => this.onEnvelope(env)),
      sig.on('disconnected', ({ reason, retryInMs }) => {
        this.t.log(`relay disconnected (${reason}); retry in ${retryInMs}ms`);
        this.joined = false;
        this.clearOfferTimer();
        this.recompute();
      }),
      sig.on('error', ({ code, message }) => this.t.log(`relay error ${code}: ${message}`)),
      sig.on('superseded', () => {
        // This deviceId joined the relay from somewhere else (another tab). Yield to it.
        this.t.log('superseded by another session of this device; going idle');
        this.stop();
      }),
    ];
    this.recompute();
    sig.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.epoch++;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.signaling?.stop();
    this.signaling = null;
    this.joined = false;
    this.peerInRoom = false;
    this.clearOfferTimer();
    this.dropSession('stopped');
    this.recompute();
  }

  send(frame: ControlFrame): boolean {
    const s = this.session;
    if (this._state !== 'connected' || !s?.open) return false;
    try {
      s.dc.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  sendBlob(memeId: string, mime: string, data: Uint8Array): Promise<void> {
    const s = this.session;
    if (this._state !== 'connected' || !s?.open) return Promise.reject(new Error('not connected'));
    if (data.byteLength < 1 || data.byteLength > MAX_MEME_BYTES) {
      return Promise.reject(new Error(`blob size ${data.byteLength} out of range`));
    }
    // One transfer at a time keeps chunks of different blobs from interleaving.
    const run = this.blobChain.then(() => this.transfer(s, memeId, mime, data));
    this.blobChain = run.catch(() => {});
    return run;
  }

  // ─── signaling events ─────────────────────────────────────────────────────

  private onJoined(peerPresent: boolean): void {
    this.joined = true;
    this.peerInRoom = peerPresent;
    this.t.log(`joined (peerPresent=${peerPresent})`);
    if (this.session?.open) return this.recompute(); // relay-only reconnect: keep the channel
    this.dropSession('rejoined');
    // Protocol: the partner (who gets peer-joined) offers. Offer ourselves only as a fallback.
    if (peerPresent) this.scheduleOffer(withJitter(this.t.offerFallbackMs, 0.5));
    this.recompute();
  }

  private onPeerJoined(): void {
    this.peerInRoom = true;
    this.peerJoinedAt = Date.now();
    this.t.log('peer-joined');
    if (this.session?.open) {
      // Either the partner's relay socket flapped (channel fine) or they reloaded
      // (channel about to die). Ping to find out.
      this.probeChannel(this.session);
    } else {
      this.dropSession('peer-joined');
      this.offerNow();
    }
    this.recompute();
  }

  private onPeerLeft(): void {
    this.peerInRoom = false;
    this.t.log('peer-left');
    this.clearOfferTimer();
    // An open channel survives the partner's relay socket dropping; DC close / ICE
    // failure will tell us if they're really gone.
    if (this.session && !this.session.open) this.dropSession('peer-left');
    this.recompute();
  }

  private onEnvelope(env: SignedEnvelope): void {
    const epoch = this.epoch;
    // Sequential: openSignal is async and SDP must be processed before its candidates.
    this.inQueue = this.inQueue.then(async () => {
      let p = null;
      try {
        p = await openSignal(this.opts.keys, env, { seenNonces: this.seenNonces });
      } catch {
        p = null;
      }
      if (!p) return this.t.log('dropped envelope: verification failed');
      this.rememberNonce(p.nonce, p.ts);
      if (p.from === this.opts.deviceId) return this.t.log('dropped envelope: from self');
      if (epoch !== this.epoch || !this.started) return;
      this.onSignal(p.from, p.data);
    });
  }

  private onSignal(from: string, data: SignalData): void {
    switch (data.kind) {
      case 'offer': {
        const { sid, sdp } = untagSdp(data.sdp);
        if (!sid) return this.t.log('offer without session tag');
        const cur = this.session;
        if (cur?.awaitingAnswer && this.opts.deviceId < from) {
          return this.t.log('glare: keeping our offer (impolite)');
        }
        this.peerDeviceId = from;
        this.t.log(`offer ${sid} from ${from}`);
        this.newSession('answerer', sid).acceptOffer(sdp);
        break;
      }
      case 'answer': {
        const { sid, sdp } = untagSdp(data.sdp);
        const cur = this.session;
        if (!cur || cur.role !== 'offerer' || cur.sid !== sid || !cur.awaitingAnswer) {
          return this.t.log(`stale answer ${sid}`);
        }
        this.peerDeviceId = from;
        cur.acceptAnswer(sdp);
        break;
      }
      case 'ice':
        this.session?.addIce(data.candidate);
        break;
    }
  }

  private sendSignal(data: SignalData): void {
    const epoch = this.epoch;
    this.outQueue = this.outQueue
      .then(async () => {
        const env = await signSignal(this.opts.keys, this.opts.deviceId, data);
        if (epoch === this.epoch && !this.signaling?.send(env)) this.t.log(`could not send ${data.kind}`);
      })
      .catch((err) => this.t.log(`sign failed: ${String(err)}`));
  }

  private rememberNonce(nonce: string, ts: number): void {
    this.nonceLog.push({ nonce, ts });
    // Nonces older than the skew window are rejected by timestamp anyway.
    const cutoff = Date.now() - SIGNAL_MAX_SKEW_MS - 60_000;
    while (this.nonceLog.length && this.nonceLog[0]!.ts < cutoff) {
      this.seenNonces.delete(this.nonceLog.shift()!.nonce);
    }
  }

  // ─── sessions ─────────────────────────────────────────────────────────────

  private newSession(role: 'offerer' | 'answerer', sid?: string): PeerSession {
    this.dropSession('superseded');
    const RTC = this.opts.RTCPeerConnectionImpl ?? globalThis.RTCPeerConnection;
    const s = new PeerSession({
      RTCPeerConnectionImpl: RTC,
      iceServers: this.opts.iceServers,
      role,
      sid,
      lowWaterMark: this.t.lowWaterMark,
      onSignal: (d) => {
        if (s === this.session) this.sendSignal(d);
      },
      onOpen: (x) => this.onSessionOpen(x),
      onMessage: (x, d) => this.onSessionMessage(x, d),
      onClose: (x, reason) => this.onSessionClose(x, reason),
    });
    this.session = s;
    this.armWatchdog(s);
    this.recompute();
    return s;
  }

  /** Forget the current session without scheduling a renegotiation. */
  private dropSession(reason: string): void {
    const s = this.session;
    this.session = null;
    this.clearWatchdog();
    this.clearProbe();
    if (s) {
      s.close(reason);
      this.onChannelLost(reason);
    }
  }

  private offerNow(): void {
    this.clearOfferTimer();
    if (!this.started || !this.joined || !this.peerInRoom) return;
    if (this.session) return; // something is already in progress (watchdog covers stalls)
    this.t.log('offering');
    this.newSession('offerer').makeOffer();
  }

  private scheduleOffer(delayMs: number): void {
    this.clearOfferTimer();
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null;
      this.offerNow();
    }, delayMs);
  }

  private clearOfferTimer(): void {
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = null;
  }

  private armWatchdog(s: PeerSession): void {
    this.clearWatchdog();
    const ms = Math.min(30_000, this.t.negotiateTimeoutMs * 2 ** Math.min(this.negotiateFailures, 4));
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (s !== this.session || s.open) return;
      this.negotiateFailures++;
      this.t.log(`negotiation timed out (${ms}ms)`);
      this.dropSession('negotiate-timeout');
      this.offerNow();
    }, ms);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private onSessionOpen(s: PeerSession): void {
    if (s !== this.session) return;
    this.t.log(`channel open (${s.role}, ${s.sid})`);
    this.clearWatchdog();
    this.clearOfferTimer();
    this.negotiateFailures = 0;
    this.recompute();
  }

  private onSessionClose(s: PeerSession, reason: string): void {
    if (s !== this.session) return;
    this.t.log(`channel lost: ${reason}`);
    this.session = null;
    this.clearWatchdog();
    this.clearProbe();
    this.onChannelLost(reason);
    this.recompute();
    if (this.started && this.joined && this.peerInRoom) {
      // Both sides notice; the impolite one re-offers first, the polite one is the fallback.
      // Exception: the partner just (re)joined and per protocol is waiting for *our* offer.
      const impolite = this.peerDeviceId !== null && this.opts.deviceId < this.peerDeviceId;
      const freshPeer = Date.now() - this.peerJoinedAt < 10_000;
      if (freshPeer) return this.offerNow();
      const base = this.peerDeviceId === null ? 1000 : impolite ? 200 : 2500;
      this.scheduleOffer(withJitter(base, 0.5));
    }
  }

  private onChannelLost(reason: string): void {
    const err = new Error(`connection lost (${reason})`);
    for (const reject of [...this.waiters]) reject(err);
    this.waiters.clear();
    this.reassembler.reset();
  }

  // ─── DataChannel traffic ──────────────────────────────────────────────────

  private onSessionMessage(s: PeerSession, data: string | ArrayBuffer): void {
    if (s !== this.session) return;
    if (typeof data === 'string') {
      const frame = parseControlFrame(data);
      if (frame) this.emitter.emit('frame', frame);
      else this.t.log('dropped invalid control frame');
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const msg = decodeBinary(data);
    if (!msg) return this.t.log('dropped invalid binary frame');
    const h = msg.header;
    if (h.t === 'chunk') this.reassembler.push(h, msg.payload);
    else if (h.t === 'ping') this.sendRaw(s, encodeBinary({ t: 'pong', n: h.n }));
    else if (h.t === 'pong' && this.probe?.n === h.n) this.clearProbe();
  }

  private probeChannel(s: PeerSession): void {
    if (this.probe) return;
    const n = Math.floor(Math.random() * 2 ** 31);
    const timer = setTimeout(() => {
      this.probe = null;
      if (s !== this.session) return;
      this.t.log('probe timed out; renegotiating');
      this.dropSession('probe-timeout');
      this.offerNow();
      this.recompute();
    }, this.t.probeTimeoutMs);
    this.probe = { n, timer };
    if (!this.sendRaw(s, encodeBinary({ t: 'ping', n }))) {
      clearTimeout(timer);
      this.probe = null;
      this.dropSession('probe-send-failed');
      this.offerNow();
    }
  }

  private clearProbe(): void {
    if (this.probe) clearTimeout(this.probe.timer);
    this.probe = null;
  }

  private sendRaw(s: PeerSession, buf: ArrayBuffer): boolean {
    if (!s.open) return false;
    try {
      s.dc.send(buf);
      return true;
    } catch {
      return false;
    }
  }

  private async transfer(s: PeerSession, memeId: string, mime: string, data: Uint8Array): Promise<void> {
    const alive = () => s === this.session && s.open;
    if (!alive()) throw new Error('not connected');
    const id = randomId(8);
    for (const msg of chunkBlob(id, memeId, mime, data)) {
      if (s.dc.bufferedAmount > this.t.highWaterMark) await this.drain(s, () => s.dc.bufferedAmount <= this.t.lowWaterMark);
      if (!alive()) throw new Error('connection lost during transfer');
      s.dc.send(msg);
    }
    // Resolve only once everything has been handed to SCTP.
    await this.drain(s, () => s.dc.bufferedAmount === 0);
  }

  /** Wait until `done()` (checked on bufferedamountlow and on a short poll); reject if the channel is lost. */
  private drain(s: PeerSession, done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        clearInterval(poll);
        s.dc.removeEventListener('bufferedamountlow', check);
        this.waiters.delete(fail);
        if (err) reject(err);
        else resolve();
      };
      const fail = (err: Error) => finish(err);
      const check = () => {
        if (s !== this.session || !s.open) finish(new Error('connection lost during transfer'));
        else if (done()) finish();
      };
      const poll = setInterval(check, 25);
      s.dc.addEventListener('bufferedamountlow', check);
      this.waiters.add(fail);
    });
  }

  // ─── state ────────────────────────────────────────────────────────────────

  private recompute(): void {
    let next: ConnectionState;
    if (!this.started) next = 'idle';
    else if (this.session?.open) next = 'connected';
    else if (this.joined && this.signaling?.status === 'joined' && !this.peerInRoom) next = 'waiting';
    else next = 'connecting';
    if (next === this._state) return;
    this._state = next;
    this.t.log(`state → ${next}`);
    this.emitter.emit('state', next);
  }
}
