import type { ServerResponse } from 'node:http';
import { PROXY_IMAGE_HOSTS, PROXY_MAX_IMAGE_BYTES, REDDIT_SORTS, SUBREDDIT_PATTERN } from '@memes/shared';
import { API_HEADERS, sendJson } from './http-util';

/**
 * Stateless pass-through proxies. Requests carry no client headers upstream
 * (no cookies, no client IP, no referrer): only a generic User-Agent and an
 * Accept header. Nothing is cached in memory or on disk, and every response is
 * `Cache-Control: no-store`.
 */

export const UPSTREAM_USER_AGENT = 'MemePalsRelay/0.1';
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDDIT_AFTER_PATTERN = /^t[1-6]_[A-Za-z0-9]{1,16}$/;
const REDDIT_TOP_WINDOWS = ['hour', 'day', 'week', 'month', 'year', 'all'];
const IMAGE_HOSTS: ReadonlySet<string> = new Set(PROXY_IMAGE_HOSTS);

export interface ProxyOptions {
  fetchImpl: typeof fetch;
  /** Timeout for upstream headers, and max idle time between body chunks. */
  timeoutMs: number;
  maxImageBytes?: number;
}

class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Fetch with manual redirects: each hop must be https and pass `allowHost`. */
async function fetchUpstream(
  opts: ProxyOptions,
  url: URL,
  allowHost: (host: string) => boolean,
  accept: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await opts.fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': UPSTREAM_USER_AGENT, Accept: accept },
    });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!location || hop >= MAX_REDIRECTS) throw new UpstreamError(502, 'upstream-redirect');
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new UpstreamError(502, 'upstream-redirect');
    }
    if (!isSafeUrl(next) || !allowHost(next.hostname)) throw new UpstreamError(502, 'redirect-not-allowed');
    current = next;
  }
}

/** https, default port, no credentials. */
function isSafeUrl(u: URL): boolean {
  return u.protocol === 'https:' && (u.port === '' || u.port === '443') && !u.username && !u.password;
}

/** An AbortController whose timer can be re-armed (idle timeout). */
function deadline(ms: number) {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new UpstreamError(504, 'upstream-timeout')), ms);
  };
  arm();
  return { signal: ctrl.signal, arm, abort: () => ctrl.abort(), clear: () => clearTimeout(timer) };
}

function upstreamFailure(res: ServerResponse, err: unknown, signal: AbortSignal): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof UpstreamError) return sendJson(res, err.status, { error: err.code });
  if (signal.aborted && signal.reason instanceof UpstreamError) {
    return sendJson(res, signal.reason.status, { error: signal.reason.code });
  }
  sendJson(res, 502, { error: 'upstream-unreachable' });
}

/** Read a body fully, up to `max` bytes. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number, onChunk?: () => void): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk?.();
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError(502, 'upstream-too-large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function proxyJson(
  res: ServerResponse,
  opts: ProxyOptions,
  url: URL,
  allowHost: (host: string) => boolean,
): Promise<void> {
  const t = deadline(opts.timeoutMs);
  const onClientGone = () => t.abort();
  res.once('close', onClientGone);
  try {
    const upstream = await fetchUpstream(opts, url, allowHost, 'application/json', t.signal);
    t.arm();
    if (!upstream.ok) {
      // Keep Reddit's `reason` (e.g. "private", "banned") so the client can explain
      // why a subreddit is unavailable; everything else in the body is dropped.
      let reason: string | undefined;
      try {
        const body = JSON.parse((await readCapped(upstream.body, 16 * 1024, t.arm)).toString('utf8'));
        if (typeof body?.reason === 'string' && /^[\w-]{1,32}$/.test(body.reason)) reason = body.reason;
      } catch {
        await upstream.body?.cancel().catch(() => {});
      }
      const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
      return sendJson(res, status, { error: 'upstream-status', status: upstream.status, ...(reason ? { reason } : {}) });
    }
    const type = upstream.headers.get('content-type') ?? '';
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
      await upstream.body?.cancel().catch(() => {});
      return sendJson(res, 502, { error: 'upstream-not-json' });
    }
    const buf = await readCapped(upstream.body, MAX_JSON_BYTES, t.arm);
    try {
      JSON.parse(buf.toString('utf8'));
    } catch {
      return sendJson(res, 502, { error: 'upstream-not-json' });
    }
    res.writeHead(200, { ...API_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  } catch (err) {
    upstreamFailure(res, err, t.signal);
  } finally {
    t.clear();
    res.off('close', onClientGone);
  }
}

/** GET /proxy/reddit/r/:sub/:sort.json?after=&limit=&t= */
export async function handleReddit(
  res: ServerResponse,
  reqUrl: URL,
  opts: ProxyOptions,
): Promise<void> {
  const m = /^\/proxy\/reddit\/r\/([^/]+)\/([^/]+)\.json$/.exec(reqUrl.pathname);
  if (!m) return sendJson(res, 404, { error: 'not-found' });
  const [, sub, sort] = m;
  if (!SUBREDDIT_PATTERN.test(sub)) return sendJson(res, 400, { error: 'bad-subreddit' });
  if (!(REDDIT_SORTS as readonly string[]).includes(sort)) return sendJson(res, 400, { error: 'bad-sort' });

  const upstream = new URL(`https://www.reddit.com/r/${sub}/${sort}.json`);
  upstream.searchParams.set('raw_json', '1');

  const limit = reqUrl.searchParams.get('limit');
  if (limit !== null && limit !== '') {
    if (!/^\d{1,3}$/.test(limit) || +limit < 1 || +limit > 100) return sendJson(res, 400, { error: 'bad-limit' });
    upstream.searchParams.set('limit', String(+limit));
  }
  const after = reqUrl.searchParams.get('after');
  if (after !== null && after !== '') {
    if (!REDDIT_AFTER_PATTERN.test(after)) return sendJson(res, 400, { error: 'bad-after' });
    upstream.searchParams.set('after', after);
  }
  const t = reqUrl.searchParams.get('t');
  if (t !== null && t !== '') {
    if (!REDDIT_TOP_WINDOWS.includes(t)) return sendJson(res, 400, { error: 'bad-t' });
    upstream.searchParams.set('t', t);
  }

  await proxyJson(res, opts, upstream, (h) => h === 'www.reddit.com');
}

/** GET /proxy/imgflip/get_memes */
export async function handleImgflip(res: ServerResponse, opts: ProxyOptions): Promise<void> {
  await proxyJson(res, opts, new URL('https://api.imgflip.com/get_memes'), (h) => h === 'api.imgflip.com');
}

/** GET /proxy/image?url=<encoded https URL on an allow-listed host> */
export async function handleImage(
  res: ServerResponse,
  reqUrl: URL,
  opts: ProxyOptions,
): Promise<void> {
  const max = opts.maxImageBytes ?? PROXY_MAX_IMAGE_BYTES;
  const raw = reqUrl.searchParams.get('url');
  if (!raw || raw.length > 2048) return sendJson(res, 400, { error: 'bad-url' });
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return sendJson(res, 400, { error: 'bad-url' });
  }
  if (!isSafeUrl(target)) return sendJson(res, 400, { error: 'bad-url' });
  if (!IMAGE_HOSTS.has(target.hostname)) return sendJson(res, 403, { error: 'host-not-allowed' });

  const t = deadline(opts.timeoutMs);
  const onClientGone = () => t.abort();
  res.once('close', onClientGone);
  try {
    const upstream = await fetchUpstream(opts, target, (h) => IMAGE_HOSTS.has(h), 'image/*', t.signal);
    t.arm();
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
      return sendJson(res, status, { error: 'upstream-status', status: upstream.status });
    }
    const type = (upstream.headers.get('content-type') ?? '').trim();
    // SVG can carry script and would run on this origin: never pass it through.
    if (!/^image\/[\w.+-]+/i.test(type) || /^image\/svg/i.test(type)) {
      await upstream.body?.cancel().catch(() => {});
      return sendJson(res, 415, { error: 'not-an-image' });
    }
    const lenHeader = upstream.headers.get('content-length');
    const declared = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : undefined;
    if (declared !== undefined && declared > max) {
      await upstream.body?.cancel().catch(() => {});
      return sendJson(res, 413, { error: 'too-large' });
    }

    res.writeHead(200, {
      ...API_HEADERS,
      'Content-Type': type,
      ...(declared !== undefined ? { 'Content-Length': declared } : {}),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (!upstream.body) return void res.end();

    const reader = upstream.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      t.arm();
      total += value.byteLength;
      if (total > max || (declared !== undefined && total > declared)) {
        await reader.cancel().catch(() => {});
        res.destroy(); // headers are out: abort the connection so the client sees a failed transfer
        return;
      }
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
      if (res.destroyed) {
        await reader.cancel().catch(() => {});
        return;
      }
    }
    res.end();
  } catch (err) {
    upstreamFailure(res, err, t.signal);
  } finally {
    t.clear();
    res.off('close', onClientGone);
  }
}
