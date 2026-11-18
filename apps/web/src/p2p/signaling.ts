import type { RelayErrorCode, SignedEnvelope } from '@memes/shared';
import { Emitter, HEARTBEAT_MS, parseRelayToClient } from '@memes/shared';
import type { BackoffOptions } from './backoff';
import { createBackoff, withJitter } from './backoff';

/**
 * Relay WebSocket client: join a room, forward signed envelopes, heartbeat, and
 * reconnect with backoff until stop(). It knows nothing about WebRTC or signatures.
 */

export type SignalingStatus = 'idle' | 'connecting' | 'joined';

export type SignalingEvents = {
  status: SignalingStatus;
  joined: { peerPresent: boolean };
  'peer-joined': undefined;
  'peer-left': undefined;
  signal: SignedEnvelope;
  error: { code: RelayErrorCode; message: string };
  /** The socket went away (before or after joining); a reconnect is scheduled. */
  disconnected: { reason: string; retryInMs: number };
  /**
   * The relay closed us with CLOSE_REPLACED: the same deviceId joined from elsewhere
   * (e.g. a second tab). We do not reconnect — that would ping-pong forever. Status is idle.
   */
  superseded: undefined;
};

/** Relay close codes (see apps/relay). */
export const CLOSE_REPLACED = 4000;
export const CLOSE_ROOM_FULL = 4001;

export interface SignalingOptions {
  /** Full WebSocket URL, e.g. toWsUrl(relayUrl). */
  url: string;
  room: string;
  deviceId: string;
  WebSocketImpl?: typeof WebSocket;
  heartbeatMs?: number;
  /** Give up on a socket that hasn't joined within this long. */
  connectTimeoutMs?: number;
  /** Deadline for the pong after an on-demand probe (online / visible). */
  probeTimeoutMs?: number;
  backoff?: BackoffOptions;
  /** Minimum delay after a `room-full` error. */
  roomFullDelayMs?: number;
  /** A join must last this long before the backoff resets. */
  stableMs?: number;
  /** Listen to window `online` / document `visibilitychange`. Default: when window exists. */
  browserHooks?: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

export class SignalingClient {
  private emitter = new Emitter<SignalingEvents>();
  private ws: WebSocket | null = null;
  private gen = 0;
  private started = false;
  private _status: SignalingStatus = 'idle';
  private backoff;
  private retryTimer: Timer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: Timer | null = null;
  private probeTimer: Timer | null = null;
  private stableTimer: Timer | null = null;
  private awaitingPong = false;
  private nextDelayOverride: number | null = null;
  private detachHooks: (() => void) | null = null;

  constructor(private opts: SignalingOptions) {
    this.backoff = createBackoff({ baseMs: 1000, maxMs: 30_000, ...opts.backoff });
  }

  get status(): SignalingStatus {
    return this._status;
  }

  on<K extends keyof SignalingEvents>(event: K, cb: (p: SignalingEvents[K]) => void) {
    return this.emitter.on(event, cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attachHooks();
    this.connect();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.detachHooks?.();
    this.detachHooks = null;
    this.clearRetry();
    this.teardownSocket();
    this.backoff.reset();
    this.setStatus('idle');
  }

  /** Send a signed envelope to the partner. False if not joined. */
  send(envelope: SignedEnvelope): boolean {
    if (this._status !== 'joined') return false;
    return this.raw({ type: 'signal', envelope });
  }

  /**
   * Network is back / app is visible again: connect immediately if we're waiting on a
   * backoff timer, or probe the live socket (mobile sockets often die silently in background).
   */
  reconnectNow(): void {
    if (!this.started) return;
    if (this.ws && this._status === 'joined') return this.probe();
    if (this.ws) return; // still connecting
    this.clearRetry();
    this.connect();
  }

  /** Ping now and treat the socket as dead if no pong arrives within probeTimeoutMs. */
  probe(): void {
    if (!this.ws || this.probeTimer) return;
    const gen = this.gen;
    this.raw({ type: 'ping' });
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (gen === this.gen) this.dead('probe-timeout');
    }, this.opts.probeTimeoutMs ?? 5000);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private connect(): void {
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    const gen = ++this.gen;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(this.opts.url);
    } catch (err) {
      this.ws = null;
      this.scheduleRetry(`construct: ${String(err)}`);
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (gen === this.gen && this._status !== 'joined') this.dead('connect-timeout');
    }, this.opts.connectTimeoutMs ?? 10_000);

    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.raw({ type: 'join', room: this.opts.room, deviceId: this.opts.deviceId });
      this.startHeartbeat(gen);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (gen !== this.gen || typeof ev.data !== 'string') return;
      this.onFrame(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (gen !== this.gen) return;
      if (ev.code === CLOSE_REPLACED) return this.superseded();
      if (ev.code === CLOSE_ROOM_FULL) return this.roomFull();
      this.dead(`closed ${ev.code}`);
    };
    ws.onerror = () => {
      if (gen === this.gen) this.dead('error');
    };
  }

  private onFrame(raw: string): void {
    const msg = parseRelayToClient(raw);
    if (!msg) return;
    // Any frame from the relay is proof of life.
    this.awaitingPong = false;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    switch (msg.type) {
      case 'joined':
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.setStatus('joined');
        this.armStable();
        this.emitter.emit('joined', { peerPresent: msg.peerPresent });
        break;
      case 'peer-joined':
      case 'peer-left':
        this.emitter.emit(msg.type, undefined);
        break;
      case 'signal':
        this.emitter.emit('signal', msg.envelope);
        break;
      case 'pong':
        break;
      case 'error':
        this.emitter.emit('error', { code: msg.code, message: msg.message });
        this.onRelayError(msg.code);
        break;
    }
  }

  private onRelayError(code: RelayErrorCode): void {
    switch (code) {
      case 'room-full':
        this.roomFull();
        break;
      case 'rate-limited':
      case 'bad-request':
      case 'not-joined':
        // Before join these mean the join itself was refused: retry on backoff.
        // After join they concern a single forwarded message; negotiation retries cover it.
        if (this._status !== 'joined') this.dead(code);
        break;
      case 'too-large':
        break;
    }
  }

  private startHeartbeat(gen: number): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      if (gen !== this.gen) return;
      if (this.awaitingPong) return this.dead('heartbeat-timeout');
      this.awaitingPong = true;
      this.raw({ type: 'ping' });
    }, this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private armStable(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    const gen = this.gen;
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (gen === this.gen && this._status === 'joined') this.backoff.reset();
    }, this.opts.stableMs ?? 5000);
  }

  /** Someone else holds the second seat (error frame and/or close 4001). Hammering won't help. */
  private roomFull(): void {
    const min = this.opts.roomFullDelayMs ?? 30_000;
    this.nextDelayOverride = withJitter(min, 0.5);
    this.dead('room-full');
  }

  private superseded(): void {
    this.teardownSocket();
    if (!this.started) return;
    this.started = false;
    this.detachHooks?.();
    this.detachHooks = null;
    this.clearRetry();
    this.backoff.reset();
    this.setStatus('idle');
    this.emitter.emit('superseded', undefined);
  }

  /** The current socket is unusable: drop it and schedule a reconnect. */
  private dead(reason: string): void {
    this.teardownSocket();
    if (!this.started) return;
    this.scheduleRetry(reason);
  }

  private scheduleRetry(reason: string): void {
    this.setStatus('connecting');
    const delay = this.nextDelayOverride ?? this.backoff.next();
    this.nextDelayOverride = null;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.started) this.connect();
    }, delay);
    this.emitter.emit('disconnected', { reason, retryInMs: delay });
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private teardownSocket(): void {
    this.gen++;
    this.stopHeartbeat();
    for (const t of [this.connectTimer, this.probeTimer, this.stableTimer]) if (t) clearTimeout(t);
    this.connectTimer = this.probeTimer = this.stableTimer = null;
    this.awaitingPong = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private raw(msg: object): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private setStatus(s: SignalingStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.emitter.emit('status', s);
  }

  private attachHooks(): void {
    const enabled = this.opts.browserHooks ?? typeof window !== 'undefined';
    if (!enabled || typeof window === 'undefined') return;
    const onOnline = () => this.reconnectNow();
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.reconnectNow();
    };
    window.addEventListener('online', onOnline);
    document?.addEventListener?.('visibilitychange', onVisible);
    this.detachHooks = () => {
      window.removeEventListener('online', onOnline);
      document?.removeEventListener?.('visibilitychange', onVisible);
    };
  }
}
