import { toHttpUrl } from '@memes/shared';
import { MemeError } from './errors';

export type Route = 'direct' | 'proxy';

/**
 * Remembers, per key (e.g. "reddit", "image:i.redd.it"), which route last worked.
 * Lives as long as one MemeServices instance, i.e. the app session.
 */
export class RouteMemory {
  private routes = new Map<string, Route>();
  get(key: string): Route | undefined {
    return this.routes.get(key);
  }
  set(key: string, route: Route): void {
    this.routes.set(key, route);
  }
}

/** Statuses that suggest "this route is blocked", not "this resource is bad". */
export const FAILOVER_STATUSES: ReadonlySet<number> = new Set([403, 429]);

export interface FallbackRequest {
  fetchImpl: typeof fetch;
  memory: RouteMemory;
  key: string;
  directUrl: string;
  /** null when no proxy route exists for this request (e.g. a non-allow-listed image host). */
  proxyUrl: string | null;
  init?: RequestInit;
}

export interface FallbackResult {
  res: Response;
  route: Route;
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** The order to try routes in: the remembered one first. */
export function routeOrder(remembered: Route | undefined, hasProxy: boolean): Route[] {
  if (!hasProxy) return ['direct'];
  return remembered === 'proxy' ? ['proxy', 'direct'] : ['direct', 'proxy'];
}

/**
 * Fetch `directUrl`, failing over to `proxyUrl` on a network/CORS error (fetch rejects)
 * or a 403/429. The remembered route is tried first. A route that answers with any
 * other status (including 404) counts as "working" and is remembered.
 *
 * The last route's response is returned whatever its status; if it rejected, this
 * throws MemeError('network').
 */
export async function fetchWithFallback(req: FallbackRequest): Promise<FallbackResult> {
  const order = routeOrder(req.memory.get(req.key), req.proxyUrl !== null);
  let lastError: unknown;
  for (let i = 0; i < order.length; i++) {
    const route = order[i]!;
    const isLast = i === order.length - 1;
    const url = route === 'direct' ? req.directUrl : req.proxyUrl!;
    let res: Response;
    try {
      res = await req.fetchImpl(url, req.init);
    } catch (err) {
      if (isAbort(err)) throw err;
      lastError = err;
      continue;
    }
    const blocked = FAILOVER_STATUSES.has(res.status);
    if (blocked && !isLast) {
      res.body?.cancel().catch(() => {});
      lastError = new Error(`HTTP ${res.status} from ${route} route`);
      continue;
    }
    if (!blocked) req.memory.set(req.key, route);
    return { res, route };
  }
  throw new MemeError('network', 'Could not reach the server (offline, blocked, or the relay is down).', {
    cause: lastError,
  });
}

/**
 * Builds relay proxy URLs. An empty relay URL means "same origin as the app"
 * (Settings.relayUrl === ''), so we return a root-relative path in that case
 * instead of letting toHttpUrl('') produce "https:///proxy/...".
 */
export function makeProxyUrl(getRelayUrl: () => string): (path: string) => string {
  return (path) => {
    const base = (getRelayUrl() ?? '').trim();
    return base ? toHttpUrl(base, path) : path.startsWith('/') ? path : '/' + path;
  };
}

/**
 * Read a response body into memory, refusing anything bigger than `maxBytes`
 * (checked against Content-Length up front and again while streaming).
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new MemeError('too-large', `Image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooLarge();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Shared request options: never send cookies or our origin to meme hosts. */
export const PRIVATE_FETCH_INIT: RequestInit = {
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
};

/** Read JSON or throw MemeError('bad-response'). */
export async function readJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    throw new MemeError('bad-response', `${what} returned something that isn't JSON.`, { cause: err, status: res.status });
  }
}
