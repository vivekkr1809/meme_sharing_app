/**
 * Just enough of RTCPeerConnection / RTCDataChannel for Node tests of the transport logic.
 * Two FakePCs "connect" once each has the other's description (matched by ids embedded in
 * the fake SDP); their DataChannels then open and deliver messages asynchronously, with a
 * simulated bufferedAmount so backpressure code paths run.
 */

let nextId = 1;

export class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer: FakeDataChannel | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onbufferedamountlow: ((ev: Event) => void) | null = null;
  constructor(readonly label: string) {
    super();
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: not open');
    const copy = typeof data === 'string' ? data : data.slice(0);
    const size = typeof copy === 'string' ? copy.length : copy.byteLength;
    this.bufferedAmount += size;
    setTimeout(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.fire('bufferedamountlow');
      }
      const peer = this.peer;
      if (this.readyState === 'open' && peer?.readyState === 'open') {
        const ev = new MessageEvent('message', { data: copy });
        peer.onmessage?.(ev);
        peer.dispatchEvent(ev);
      }
    }, 0);
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.fire('close');
    const peer = this.peer;
    this.peer = null;
    if (peer) setTimeout(() => peer.close(), 0);
  }

  _open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.fire('open');
  }

  private fire(type: 'open' | 'close' | 'bufferedamountlow'): void {
    const ev = new Event(type);
    (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${type}`]?.(ev);
    this.dispatchEvent(ev);
  }
}

export class FakePeerConnection {
  static all: FakePeerConnection[] = [];
  static reset() {
    FakePeerConnection.all = [];
  }

  readonly id = nextId++;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState: RTCSignalingState = 'stable';
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  closed = false;
  dc: FakeDataChannel | null = null;
  addedIce: RTCIceCandidateInit[] = [];
  /** Order of interesting calls, for assertions. */
  calls: string[] = [];
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(readonly config?: RTCConfiguration) {
    FakePeerConnection.all.push(this);
  }

  createDataChannel(label: string, _opts?: RTCDataChannelInit): FakeDataChannel {
    this.dc = new FakeDataChannel(label);
    return this.dc;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: `v=0\r\na=fake-pc:${this.id}\r\n` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: `v=0\r\na=fake-pc:${this.id}\r\n` };
  }

  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.check();
    this.calls.push(`local:${d.type}`);
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    setTimeout(() => {
      if (this.closed) return;
      const cand = {
        candidate: `candidate:1 1 udp 2122260223 10.0.0.${this.id} 5000 typ host`,
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: `u${this.id}`,
      };
      this.onicecandidate?.({ candidate: cand as RTCIceCandidate });
      this.onicecandidate?.({ candidate: null });
    }, 0);
    this.tryLink();
  }

  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.check();
    this.calls.push(`remote:${d.type}`);
    if (!/a=fake-pc:\d+/.test(d.sdp ?? '')) throw new Error('unparseable SDP');
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.tryLink();
  }

  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
    this.check();
    this.calls.push('ice');
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description');
    this.addedIce.push(c);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signalingState = 'closed';
    this.dc?.close();
  }

  /** Simulate ICE failure. */
  _fail(): void {
    this.iceConnectionState = 'failed';
    this.oniceconnectionstatechange?.();
  }

  private check() {
    if (this.closed) throw new Error('InvalidStateError: closed');
  }

  private remotePc(): FakePeerConnection | undefined {
    const m = /a=fake-pc:(\d+)/.exec(this.remoteDescription?.sdp ?? '');
    return m ? FakePeerConnection.all.find((p) => p.id === Number(m[1])) : undefined;
  }

  private tryLink() {
    const other = this.remotePc();
    if (!other || other.remotePc() !== this || !this.localDescription || !other.localDescription) return;
    if (this.closed || other.closed || !this.dc || !other.dc) return;
    const [a, b] = [this.dc, other.dc];
    a.peer = b;
    b.peer = a;
    setTimeout(() => {
      if (this.closed || other.closed) return;
      this.iceConnectionState = other.iceConnectionState = 'connected';
      a._open();
      b._open();
    }, 1);
  }
}

export const FakeRTC = FakePeerConnection as unknown as typeof RTCPeerConnection;
