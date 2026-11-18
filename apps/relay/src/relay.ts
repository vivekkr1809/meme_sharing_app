import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RELAY_WS_PATH } from '@memes/shared';
import { DEFAULT_STUN_URLS, type IceServerConfig } from './config';
import { API_HEADERS, sendJson } from './http-util';
import { handleImage, handleImgflip, handleReddit, type ProxyOptions } from './proxy';
import { Signaling, type SignalingStats } from './signaling';
import { StaticFiles } from './static';

export type { IceServerConfig } from './config';
export type { SignalingStats } from './signaling';
export { DEFAULT_STUN_URLS, iceServersFromEnv } from './config';
export { CLOSE_REPLACED, CLOSE_ROOM_FULL } from './signaling';

export interface RelayOptions {
  /** Port to listen on; 0 picks a free port. Default 0. */
  port?: number;
  /** Interface to bind. Default 127.0.0.1 (the CLI defaults to 0.0.0.0). */
  host?: string;
  /** Directory with the built web app; served with SPA fallback when set. */
  staticDir?: string;
  /** Extra Content-Security-Policy connect-src sources for the served app. */
  cspConnectSrc?: string[];
  /** Upstream fetch for the proxies (tests inject a mock). */
  fetchImpl?: typeof fetch;
  /** Advertised at GET /config. Default: public STUN servers only. */
  iceServers?: IceServerConfig[];
  /** Lifecycle logging (counts only). Default: silent. */
  log?: (msg: string) => void;

  // ── tuning knobs, mainly for tests ──
  /** Heartbeat interval; sockets silent for 3x this are dropped. Default HEARTBEAT_MS. */
  heartbeatMs?: number;
  /** Per-socket token bucket. Default 50 messages per 10 s. */
  rateLimit?: { capacity: number; windowMs: number };
  /** Concurrent WebSocket connections per client IP. Default 20. */
  maxConnectionsPerIp?: number;
  /** Trust the last X-Forwarded-For hop as the client IP (behind Caddy/Fly/Cloudflare). Default false. */
  trustProxy?: boolean;
  /** Upstream timeout (headers, and idle time between body chunks). Default 10 s. */
  upstreamTimeoutMs?: number;
}

export interface Relay {
  /** http://host:port */
  url: string;
  port: number;
  close(): Promise<void>;
  /** In-memory counters, for tests and health checks. */
  stats(): SignalingStats;
}

const RESERVED = [RELAY_WS_PATH, '/proxy', '/config', '/health'];
const isReserved = (p: string) => RESERVED.some((r) => p === r || p.startsWith(r + '/'));

export async function createRelay(opts: RelayOptions = {}): Promise<Relay> {
  const log = opts.log ?? (() => {});
  const iceServers: IceServerConfig[] = opts.iceServers ?? [{ urls: [...DEFAULT_STUN_URLS] }];
  const proxyOpts: ProxyOptions = {
    fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
    timeoutMs: opts.upstreamTimeoutMs ?? 10_000,
  };
  const staticFiles = opts.staticDir ? new StaticFiles(opts.staticDir, { cspConnectSrc: opts.cspConnectSrc }) : undefined;
  const signaling = new Signaling({
    heartbeatMs: opts.heartbeatMs,
    rateLimit: opts.rateLimit,
    maxConnectionsPerIp: opts.maxConnectionsPerIp,
    trustProxy: opts.trustProxy,
    log,
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://relay.invalid');
    } catch {
      return sendJson(res, 400, { error: 'bad-url' });
    }
    const p = url.pathname;
    const method = req.method ?? 'GET';

    if (isReserved(p)) {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          ...API_HEADERS,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Content-Length': 0,
        });
        return void res.end();
      }
      const head = method === 'HEAD';
      if (method !== 'GET' && !head) return sendJson(res, 405, { error: 'method-not-allowed' });

      if (p === '/health') return sendJson(res, 200, { ok: true }, head);
      if (p === '/config') return sendJson(res, 200, { iceServers }, head);
      if (p === RELAY_WS_PATH) return sendJson(res, 426, { error: 'upgrade-required' }, head);
      if (head) return sendJson(res, 405, { error: 'method-not-allowed' });
      if (p.startsWith('/proxy/reddit/')) return handleReddit(res, url, proxyOpts);
      if (p === '/proxy/imgflip/get_memes') return handleImgflip(res, proxyOpts);
      if (p === '/proxy/image') return handleImage(res, url, proxyOpts);
      return sendJson(res, 404, { error: 'not-found' });
    }

    if (staticFiles && (method === 'GET' || method === 'HEAD')) {
      if (await staticFiles.serve(req, res, p)) return;
    } else if (staticFiles) {
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }
    return sendJson(res, 404, { error: 'not-found' });
  }

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      /* fallthrough */
    }
    if (pathname !== RELAY_WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    signaling.handleUpgrade(req, socket, head);
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const displayHost = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  log(`relay listening on port ${addr.port}`);

  let closing: Promise<void> | undefined;
  return {
    url: `http://${displayHost}:${addr.port}`,
    port: addr.port,
    stats: () => signaling.stats(),
    close: () =>
      (closing ??= (async () => {
        const done = new Promise<void>((resolve) => server.close(() => resolve()));
        await signaling.close();
        server.closeAllConnections();
        await done;
        log('relay closed');
      })()),
  };
}
