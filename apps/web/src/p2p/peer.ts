import type { IceCandidate, SignalData } from '@memes/shared';
import { randomId } from '@memes/shared';

/**
 * One RTCPeerConnection attempt with exactly one DataChannel (negotiated, id 0,
 * ordered + reliable). A new PeerSession is created for every (re)negotiation;
 * sessions are never reused after close().
 *
 * Offer/answer correlation: the transmitted SDP carries a session tag line
 * (`a=x-memes-sid:<hex>`) that the answer echoes. It lives inside the signed
 * payload and is stripped before setRemoteDescription, so a late answer to a
 * superseded offer can never be applied to a newer connection.
 */

const SID_LINE = /^a=x-memes-sid:([0-9a-f]{8,64})\r?\n?/m;

export function tagSdp(sdp: string, sid: string): string {
  const base = sdp.endsWith('\n') ? sdp : sdp + '\r\n';
  return `${base}a=x-memes-sid:${sid}\r\n`;
}

export function untagSdp(sdp: string): { sid: string | null; sdp: string } {
  const m = SID_LINE.exec(sdp);
  if (!m) return { sid: null, sdp };
  return { sid: m[1]!, sdp: sdp.replace(SID_LINE, '') };
}

export type PeerRole = 'offerer' | 'answerer';

export interface PeerSessionOptions {
  RTCPeerConnectionImpl: typeof RTCPeerConnection;
  iceServers?: RTCIceServer[];
  role: PeerRole;
  /** Required for answerers (taken from the offer); generated for offerers. */
  sid?: string;
  onSignal: (data: SignalData) => void;
  onOpen: (s: PeerSession) => void;
  onMessage: (s: PeerSession, data: string | ArrayBuffer) => void;
  onClose: (s: PeerSession, reason: string) => void;
  /** dc.bufferedAmountLowThreshold */
  lowWaterMark?: number;
}

export class PeerSession {
  readonly sid: string;
  readonly role: PeerRole;
  readonly createdAt = Date.now();
  readonly pc: RTCPeerConnection;
  readonly dc: RTCDataChannel;
  private closed = false;
  private remoteSet = false;
  private pendingRemoteIce: IceCandidate[] = [];
  private localSent = false;
  private pendingLocalIce: IceCandidate[] = [];
  /** Serializes async SDP operations on this pc. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private opts: PeerSessionOptions) {
    this.role = opts.role;
    this.sid = opts.sid ?? randomId(8);
    const PC = opts.RTCPeerConnectionImpl;
    this.pc = new PC({ iceServers: opts.iceServers ?? [] });
    this.dc = this.pc.createDataChannel('memes', { negotiated: true, id: 0, ordered: true });
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = opts.lowWaterMark ?? 256 * 1024;

    this.pc.onicecandidate = (ev) => {
      const c = ev.candidate;
      if (!c || !c.candidate || this.closed) return;
      const cand: IceCandidate = {
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      };
      if (this.localSent) opts.onSignal({ kind: 'ice', candidate: cand });
      else this.pendingLocalIce.push(cand);
    };
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.close('ice-failed');
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.close('connection-failed');
    };
    this.dc.onopen = () => {
      if (!this.closed) opts.onOpen(this);
    };
    this.dc.onclose = () => this.close('dc-closed');
    this.dc.onerror = () => this.close('dc-error');
    this.dc.onmessage = (ev: MessageEvent) => {
      if (!this.closed) opts.onMessage(this, ev.data as string | ArrayBuffer);
    };
  }

  get open(): boolean {
    return !this.closed && this.dc.readyState === 'open';
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True while we've sent an offer and are waiting for its answer. */
  get awaitingAnswer(): boolean {
    return !this.closed && this.role === 'offerer' && !this.remoteSet;
  }

  makeOffer(): Promise<void> {
    return this.run(async () => {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.emitLocal('offer');
    });
  }

  acceptOffer(sdp: string): Promise<void> {
    return this.run(async () => {
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      this.remoteSet = true;
      await this.flushRemoteIce();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.emitLocal('answer');
    });
  }

  acceptAnswer(sdp: string): Promise<void> {
    return this.run(async () => {
      if (this.remoteSet || this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      this.remoteSet = true;
      await this.flushRemoteIce();
    });
  }

  /** Remote candidates are buffered until the remote description is set. */
  addIce(c: IceCandidate): void {
    if (this.closed) return;
    if (!this.remoteSet) {
      if (this.pendingRemoteIce.length < 100) this.pendingRemoteIce.push(c);
      return;
    }
    this.run(() => this.addOne(c));
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.onicecandidate = this.pc.oniceconnectionstatechange = this.pc.onconnectionstatechange = null;
    this.dc.onopen = this.dc.onclose = this.dc.onerror = this.dc.onmessage = null;
    this.dc.onbufferedamountlow = null;
    try {
      this.dc.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.opts.onClose(this, reason);
  }

  private emitLocal(kind: 'offer' | 'answer'): void {
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp || this.closed) return;
    this.opts.onSignal({ kind, sdp: tagSdp(sdp, this.sid) });
    this.localSent = true;
    for (const c of this.pendingLocalIce.splice(0)) this.opts.onSignal({ kind: 'ice', candidate: c });
  }

  private async flushRemoteIce(): Promise<void> {
    for (const c of this.pendingRemoteIce.splice(0)) await this.addOne(c);
  }

  private async addOne(c: IceCandidate): Promise<void> {
    try {
      await this.pc.addIceCandidate(c);
    } catch {
      // Candidates for a superseded session (ufrag mismatch) land here; harmless.
    }
  }

  private run(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.closed) return;
      try {
        await op();
      } catch (err) {
        if (!this.closed) this.close(`negotiation-error: ${(err as Error)?.message ?? String(err)}`);
      }
    });
    this.chain = next;
    return next;
  }
}
