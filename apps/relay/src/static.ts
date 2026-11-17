import { createReadStream, type Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

/**
 * Read-only static file server for the built PWA, with SPA fallback.
 * Never writes anything. Path traversal (including encoded and backslash
 * variants, and symlinks pointing outside the root) is refused.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

const NO_CACHE_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'registerSW.js']);
/** Vite-style content hash in the file name, e.g. index-B2x9fQ_a.js or workbox-5ffe50d4.js. */
const HASHED_NAME = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export class StaticFiles {
  private rootReal?: Promise<string>;

  constructor(private readonly root: string) {}

  /** Serve a GET/HEAD request. Returns false if nothing was found (caller sends 404). */
  async serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const root = await (this.rootReal ??= realpath(path.resolve(this.root)));

    const file = await this.resolve(root, pathname);
    if (file === 'forbidden') {
      sendPlain(res, 403, 'Forbidden');
      return true;
    }
    if (file) {
      await sendFile(req, res, file.path, file.stats);
      return true;
    }
    // SPA fallback: only for navigations to extensionless routes, never for missing assets.
    if (path.posix.extname(pathname) === '' || pathname.endsWith('/')) {
      const index = await this.resolve(root, '/index.html');
      if (index && index !== 'forbidden') {
        await sendFile(req, res, index.path, index.stats);
        return true;
      }
    }
    return false;
  }

  private async resolve(root: string, pathname: string): Promise<{ path: string; stats: Stats } | 'forbidden' | null> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return 'forbidden';
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return 'forbidden';
    const segments = decoded.split('/');
    if (segments.some((s) => s === '..')) return 'forbidden';
    // Hidden files (".env", ".git") are never served; ".well-known" is allowed.
    if (segments.some((s) => s.startsWith('.') && s !== '.well-known' && s !== '.')) return 'forbidden';

    let candidate = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
    if (!isInside(root, candidate)) return 'forbidden';

    let stats: Stats;
    try {
      stats = await stat(candidate);
      if (stats.isDirectory()) {
        candidate = path.join(candidate, 'index.html');
        stats = await stat(candidate);
      }
      if (!stats.isFile()) return null;
      const real = await realpath(candidate);
      if (!isInside(root, real)) return 'forbidden';
      return { path: real, stats };
    } catch {
      return null;
    }
  }
}

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function cacheControl(file: string): string {
  const name = path.basename(file);
  if (NO_CACHE_FILES.has(name) || name.endsWith('.html')) return 'no-cache';
  if (HASHED_NAME.test(name)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, stats: Stats): Promise<void> {
  const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': cacheControl(file),
    ETag: etag,
    'Last-Modified': stats.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['Content-Length'] = stats.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(file);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}
