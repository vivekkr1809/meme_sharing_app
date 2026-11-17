import type { CreateTransport, Transport } from '../contracts';
import type { P2PTransportOptions } from './transport';
import { P2PTransport } from './transport';

export type { P2PTransportOptions, TransportTuning } from './transport';
export { P2PTransport } from './transport';

/** WebRTC transport to the partner, signaled through the relay. See transport.ts. */
export function createTransport(opts: P2PTransportOptions): Transport {
  return new P2PTransport(opts);
}

createTransport satisfies CreateTransport;
