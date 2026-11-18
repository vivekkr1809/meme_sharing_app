import type { ImgflipSource, MemeTemplate } from '../contracts';
import { MemeError } from './errors';
import { fetchWithFallback, PRIVATE_FETCH_INIT, readJson, type RouteMemory } from './net';

export const IMGFLIP_GET_MEMES_URL = 'https://api.imgflip.com/get_memes';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;

/** Map Imgflip's get_memes response to MemeTemplates, skipping malformed entries. */
export function parseImgflipTemplates(json: unknown): MemeTemplate[] {
  const root = obj(json);
  if (!root || root.success !== true) {
    const msg = typeof root?.error_message === 'string' ? `: ${root.error_message}` : '';
    throw new MemeError('bad-response', `Imgflip returned an unexpected response${msg}.`);
  }
  const memes = obj(root.data)?.memes;
  if (!Array.isArray(memes)) throw new MemeError('bad-response', 'Imgflip returned no templates.');
  const out: MemeTemplate[] = [];
  const seen = new Set<string>();
  for (const raw of memes) {
    const m = obj(raw);
    if (!m) continue;
    const id = typeof m.id === 'string' || typeof m.id === 'number' ? String(m.id) : '';
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    const width = typeof m.width === 'number' ? m.width : NaN;
    const height = typeof m.height === 'number' ? m.height : NaN;
    const boxes = typeof m.box_count === 'number' && Number.isFinite(m.box_count) ? Math.floor(m.box_count) : 2;
    let url = '';
    try {
      // Templates must come from Imgflip's image CDN (also the only host the CSP and the
      // relay's image proxy allow for them); upgrade to https like every allow-listed host.
      const u = new URL(typeof m.url === 'string' ? m.url : '');
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname === 'i.imgflip.com' && !u.username && !u.password && !u.port) {
        u.protocol = 'https:';
        url = u.href;
      }
    } catch {
      /* skip */
    }
    if (!id || !name || !url || !(width > 0) || !(height > 0) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, url, width, height, boxCount: Math.min(20, Math.max(1, boxes)) });
  }
  return out;
}

export interface ImgflipSourceDeps {
  fetchImpl: typeof fetch;
  memory: RouteMemory;
  proxyUrl: (path: string) => string;
}

/**
 * Template list only. We deliberately never call Imgflip's caption_image API:
 * that would upload the user's captions and host the finished meme on Imgflip.
 */
export function createImgflipSource(deps: ImgflipSourceDeps): ImgflipSource {
  let cached: Promise<MemeTemplate[]> | null = null;
  const load = async (): Promise<MemeTemplate[]> => {
    const { res } = await fetchWithFallback({
      fetchImpl: deps.fetchImpl,
      memory: deps.memory,
      key: 'imgflip',
      directUrl: IMGFLIP_GET_MEMES_URL,
      proxyUrl: deps.proxyUrl('/proxy/imgflip/get_memes'),
      init: PRIVATE_FETCH_INIT,
    });
    if (res.status === 429 || res.status === 403) {
      throw new MemeError('rate-limited', 'Imgflip is refusing requests right now. Try again later.', { status: res.status });
    }
    if (!res.ok) throw new MemeError('http', `Imgflip returned HTTP ${res.status}.`, { status: res.status });
    return parseImgflipTemplates(await readJson(res, 'Imgflip'));
  };
  return {
    listTemplates() {
      if (!cached) {
        cached = load();
        // Don't memoize failures: let the next call retry.
        cached.catch(() => {
          cached = null;
        });
      }
      // A fresh array per caller so one consumer sorting/filtering can't affect another.
      return cached.then((list) => list.slice());
    },
  };
}
