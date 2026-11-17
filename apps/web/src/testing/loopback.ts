import type { ConnectionState, ControlFrame } from '@memes/shared';
import { Emitter, parseControlFrame } from '@memes/shared';
import type { Transport, TransportEvents } from '../contracts';

/**
 * In-memory pair of Transports wired to each other — for unit tests of the
 * sync engine and for the UI's demo mode. Frames go through JSON to mimic the wire.
 *
 *   const { a, b, link, unlink } = createLoopbackPair();
 *   a.start(); b.start(); // both 'waiting'
 *   link();               // both 'connected'
 *   unlink();             // both 'waiting' (simulates partner going offline)
 */
export function createLoopbackPair(opts: { autoLink?: boolean } = {}) {
  let linked = false;
  const a = new LoopbackTransport();
  const b = new LoopbackTransport();
  a.peer = b;
  b.peer = a;
  const refresh = () => {
    for (const t of [a, b]) {
      if (!t.started) t.setState('idle');
      else t.setState(linked && t.peer!.started ? 'connected' : 'waiting');
    }
  };
  a.onLifecycle = b.onLifecycle = () => {
    if (opts.autoLink && a.started && b.started) linked = true;
    refresh();
  };
  return {
    a,
    b,
    link() {
      linked = true;
      refresh();
    },
    unlink() {
      linked = false;
      refresh();
    },
  };
}

export class LoopbackTransport implements Transport {
  peer?: LoopbackTransport;
  started = false;
  onLifecycle?: () => void;
  /** Every frame this side sent, for assertions. */
  sent: ControlFrame[] = [];
  private emitter = new Emitter<TransportEvents & Record<string, unknown>>();
  private _state: ConnectionState = 'idle';

  get state() {
    return this._state;
  }

  setState(s: ConnectionState) {
    if (s === this._state) return;
    this._state = s;
    this.emitter.emit('state', s);
  }

  start() {
    this.started = true;
    this.onLifecycle?.();
  }

  stop() {
    this.started = false;
    this.onLifecycle?.();
  }

  send(frame: ControlFrame): boolean {
    if (this._state !== 'connected' || !this.peer) return false;
    this.sent.push(frame);
    const wire = JSON.stringify(frame);
    const peer = this.peer;
    queueMicrotask(() => {
      const parsed = parseControlFrame(wire);
      if (parsed && peer.state === 'connected') peer.emitter.emit('frame', parsed);
    });
    return true;
  }

  async sendBlob(memeId: string, mime: string, data: Uint8Array): Promise<void> {
    if (this._state !== 'connected' || !this.peer) throw new Error('not connected');
    const copy = data.slice();
    const peer = this.peer;
    await new Promise<void>((r) => setTimeout(r, 0));
    if (this._state !== 'connected') throw new Error('disconnected during transfer');
    peer.emitter.emit('blob', { memeId, mime, data: copy });
  }

  on<K extends keyof TransportEvents>(event: K, cb: (payload: TransportEvents[K]) => void) {
    return this.emitter.on(event, cb as (p: unknown) => void);
  }
}
