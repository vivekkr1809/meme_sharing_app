import { PROXY_IMAGE_HOSTS, REDDIT_SORTS, SUBREDDIT_PATTERN, type RedditSort } from '@memes/shared';
import type { RedditPage, RedditPost, RedditSource } from '../contracts';
import { MemeError } from './errors';
import { fetchWithFallback, PRIVATE_FETCH_INIT, readJson, type RouteMemory } from './net';

// ─── Defensive JSON accessors ───────────────────────────────────────────────

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Undo HTML entity escaping (in case raw_json=1 was dropped) and accept only absolute http(s) URLs. */
export function cleanUrl(v: unknown): string | undefined {
  const s = str(v)?.replace(/&amp;/g, '&');
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const REDDIT_LINK_HOSTS = new Set(['www.reddit.com', 'reddit.com', 'old.reddit.com', 'new.reddit.com', 'redd.it']);

/**
 * A link to the post on Reddit, or undefined. `permalink` is untrusted: plain string
 * concatenation turned "@evil.example/x" into "https://www.reddit.com@evil.example/x"
 * (userinfo trick), so it is resolved as a URL and must stay on a Reddit host.
 */
export function safeRedditLink(permalink: string): string | undefined {
  try {
    const u = new URL(permalink, 'https://www.reddit.com/');
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !REDDIT_LINK_HOSTS.has(u.hostname)) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

const KNOWN_IMAGE_HOSTS: ReadonlySet<string> = new Set(PROXY_IMAGE_HOSTS);

/**
 * Only images on the known Reddit/Imgur/Imgflip CDNs are shown. Any other host would
 * learn the viewer's IP address (and that they browse this feed) just by rendering the
 * tile, and the app's Content-Security-Policy (img-src) blocks such hosts anyway.
 */
function knownImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!KNOWN_IMAGE_HOSTS.has(u.hostname) || u.username || u.password || u.port) return undefined;
    u.protocol = 'https:'; // every allow-listed host serves HTTPS
    return u.href;
  } catch {
    return undefined;
  }
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const VIDEO_EXT = /\.(gifv|mp4|webm|mov|m3u8)$/i;
const DIRECT_IMAGE_HOSTS = new Set(['i.redd.it', 'i.imgur.com']);

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** i.redd.it / i.imgur.com URL ending in an image extension. */
export function isDirectImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return DIRECT_IMAGE_HOSTS.has(u.hostname) && IMAGE_EXT.test(u.pathname);
  } catch {
    return false;
  }
}

// ─── Image extraction ───────────────────────────────────────────────────────

interface ExtractedImage {
  imageUrl: string;
  thumbUrl?: string;
  width?: number;
  height?: number;
}

interface Candidate {
  url: string;
  width: number;
  height?: number;
}

/** Target width for feed thumbnails. */
export const THUMB_TARGET_WIDTH = 640;

/** The candidate whose width is closest to THUMB_TARGET_WIDTH (ties go to the larger). */
export function pickThumb(candidates: Candidate[]): Candidate | undefined {
  let best: Candidate | undefined;
  for (const c of candidates) {
    if (!best) {
      best = c;
      continue;
    }
    const d = Math.abs(c.width - THUMB_TARGET_WIDTH);
    const bd = Math.abs(best.width - THUMB_TARGET_WIDTH);
    if (d < bd || (d === bd && c.width > best.width)) best = c;
  }
  return best;
}

function previewCandidate(v: unknown, urlKey: string, wKey: string, hKey: string): Candidate | undefined {
  const o = obj(v);
  const url = cleanUrl(o?.[urlKey]);
  const width = num(o?.[wKey]);
  if (!url || width === undefined) return undefined;
  const height = num(o?.[hKey]);
  return height === undefined ? { url, width } : { url, width, height };
}

/** Source + thumbnail from `preview.images[0]`. */
function previewInfo(d: Json): { source?: Candidate; thumb?: Candidate } {
  const img = obj(arr(obj(d.preview)?.images)[0]);
  if (!img) return {};
  const source = previewCandidate(img.source, 'url', 'width', 'height');
  const resolutions = arr(img.resolutions)
    .map((r) => previewCandidate(r, 'url', 'width', 'height'))
    .filter((c): c is Candidate => !!c);
  const thumb = pickThumb(source ? [...resolutions, source] : resolutions);
  return { ...(source ? { source } : {}), ...(thumb ? { thumb } : {}) };
}

const GALLERY_EXT: Record<string, string> = {
  'image/jpg': 'jpg',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** First usable image of a gallery post (in gallery order), from `media_metadata`. */
function galleryImage(d: Json): ExtractedImage | null {
  const meta = obj(d.media_metadata);
  if (!meta) return null;
  const ordered = arr(obj(d.gallery_data)?.items)
    .map((it) => str(obj(it)?.media_id))
    .filter((id): id is string => !!id);
  const ids = ordered.length ? ordered : Object.keys(meta);
  for (const id of ids) {
    const m = obj(meta[id]);
    if (!m) continue;
    if (m.status !== undefined && m.status !== 'valid') continue;
    const s = obj(m.s);
    let imageUrl: string | undefined;
    if (m.e === 'Image') {
      const ext = GALLERY_EXT[str(m.m)?.toLowerCase() ?? ''];
      // The original lives on i.redd.it under the media id; s.u is a re-encoded preview.
      imageUrl = ext && /^[A-Za-z0-9]+$/.test(id) ? `https://i.redd.it/${id}.${ext}` : cleanUrl(s?.u);
    } else if (m.e === 'AnimatedImage') {
      imageUrl = cleanUrl(s?.gif); // skip mp4-only animations
    }
    if (!imageUrl) continue;
    const previews = arr(m.p)
      .map((p) => previewCandidate(p, 'u', 'x', 'y'))
      .filter((c): c is Candidate => !!c);
    const thumb = pickThumb(previews);
    const width = num(s?.x);
    const height = num(s?.y);
    return {
      imageUrl,
      ...(thumb ? { thumbUrl: thumb.url } : {}),
      ...(width !== undefined && height !== undefined ? { width, height } : {}),
    };
  }
  return null;
}

/** The image a post shows, or null for videos, self posts, links, gifv, etc. */
function extractImage(d: Json): ExtractedImage | null {
  if (d.is_self === true || d.is_video === true) return null;
  const hint = str(d.post_hint);
  if (hint === 'self' || hint === 'hosted:video' || hint === 'rich:video') return null;

  if (d.is_gallery === true) return galleryImage(d);

  const url = cleanUrl(d.url_overridden_by_dest) ?? cleanUrl(d.url);
  if (url && VIDEO_EXT.test(pathOf(url))) return null;
  const { source, thumb } = previewInfo(d);
  const dims = source?.height !== undefined ? { width: source.width, height: source.height } : {};
  const thumbPart = thumb ? { thumbUrl: thumb.url } : {};

  if (url && isDirectImageUrl(url)) return { imageUrl: url, ...thumbPart, ...dims };
  if (hint === 'image') {
    if (url && IMAGE_EXT.test(pathOf(url))) return { imageUrl: url, ...thumbPart, ...dims };
    if (source) return { imageUrl: source.url, ...thumbPart, ...dims };
  }
  return null;
}

/** Parse one t3 `data` object. Exported for tests. */
export function parseRedditPost(d: Json): RedditPost | null {
  const id = str(d.id);
  if (!id) return null;
  if (str(d.removed_by_category)) return null; // removed/deleted: the image is usually gone too

  let image = extractImage(d);
  let nsfw = d.over_18 === true || d.spoiler === true;
  if (!image) {
    // Crossposts carry the media on the parent.
    const parent = obj(arr(d.crosspost_parent_list)[0]);
    if (parent && !str(parent.removed_by_category)) {
      image = extractImage(parent);
      nsfw ||= parent.over_18 === true || parent.spoiler === true;
    }
  }
  const imageUrl = knownImageUrl(image?.imageUrl);
  if (!image || !imageUrl) return null;
  const thumbUrl = knownImageUrl(image.thumbUrl);

  const subreddit = str(d.subreddit) ?? '';
  const fallbackLink = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(id)}/`;
  const permalink = safeRedditLink(str(d.permalink) ?? '') ?? safeRedditLink(fallbackLink)!;
  const post: RedditPost = {
    id,
    title: str(d.title) ?? '',
    subreddit,
    author: str(d.author) ?? '[deleted]',
    score: num(d.score) ?? 0,
    permalink,
    imageUrl,
    nsfw,
    createdAt: Math.round((num(d.created_utc) ?? 0) * 1000),
  };
  if (thumbUrl) post.thumbUrl = thumbUrl;
  if (image.width !== undefined && image.height !== undefined) {
    post.width = image.width;
    post.height = image.height;
  }
  return post;
}

/** True if the JSON is Reddit's subreddit search listing (what /r/<missing> redirects to). */
export function isSubredditSearchListing(json: unknown): boolean {
  const children = arr(obj(obj(json)?.data)?.children);
  return children.some((c) => obj(c)?.kind === 't5');
}

/** Parse a Reddit listing into image posts, deduped by id and image URL. */
export function parseRedditListing(json: unknown): RedditPage {
  const root = obj(json);
  const data = obj(root?.data);
  if (!root || root.kind !== 'Listing' || !data) {
    throw new MemeError('bad-response', 'Reddit returned an unexpected response.');
  }
  const posts: RedditPost[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  for (const child of arr(data.children)) {
    const c = obj(child);
    if (c?.kind !== 't3') continue;
    const d = obj(c.data);
    if (!d) continue;
    const post = parseRedditPost(d);
    if (!post || seenIds.has(post.id) || seenUrls.has(post.imageUrl)) continue;
    seenIds.add(post.id);
    seenUrls.add(post.imageUrl);
    posts.push(post);
  }
  return { posts, after: str(data.after) ?? null };
}

// ─── Source ─────────────────────────────────────────────────────────────────

export const REDDIT_PAGE_LIMIT = 25;

/** Path + query shared by the direct URL and the relay proxy. */
export function redditListingPath(sub: string, sort: RedditSort, after?: string | null): string {
  const q = new URLSearchParams({ raw_json: '1', limit: String(REDDIT_PAGE_LIMIT) });
  if (after) q.set('after', after);
  return `/r/${sub}/${sort}.json?${q.toString()}`;
}

async function unavailableReason(res: Response): Promise<string | undefined> {
  try {
    const body = obj(await res.json());
    return str(body?.reason);
  } catch {
    return undefined;
  }
}

export interface RedditSourceDeps {
  fetchImpl: typeof fetch;
  memory: RouteMemory;
  proxyUrl: (path: string) => string;
}

export function createRedditSource(deps: RedditSourceDeps): RedditSource {
  return {
    async fetchPage(subreddit, opts = {}) {
      const sub = subreddit.trim().replace(/^\/?r\//i, '');
      if (!SUBREDDIT_PATTERN.test(sub)) {
        throw new MemeError('invalid-subreddit', `"${subreddit}" isn't a valid subreddit name.`);
      }
      const sort = opts.sort ?? 'hot';
      if (!(REDDIT_SORTS as readonly string[]).includes(sort)) {
        throw new MemeError('invalid-subreddit', `Unknown sort "${String(sort)}".`);
      }
      const path = redditListingPath(sub, sort, opts.after);
      const { res } = await fetchWithFallback({
        fetchImpl: deps.fetchImpl,
        memory: deps.memory,
        key: 'reddit',
        directUrl: `https://www.reddit.com${path}`,
        proxyUrl: deps.proxyUrl(`/proxy/reddit${path}`),
        init: { ...PRIVATE_FETCH_INIT, headers: { Accept: 'application/json' } },
      });

      const unavailable = (reason?: string) =>
        new MemeError('subreddit-unavailable', `r/${sub} doesn't exist or is private.`, {
          status: res.status,
          ...(reason ? { reason } : {}),
        });

      if (res.status === 404 || res.status === 451 || (res.status >= 300 && res.status < 400)) {
        throw unavailable(await unavailableReason(res));
      }
      if (res.status === 403) {
        // Private/quarantined/banned subs answer 403 with a JSON `reason`;
        // a bare 403 on every route means Reddit is blocking us.
        const reason = await unavailableReason(res);
        if (reason) throw unavailable(reason);
        throw new MemeError('rate-limited', 'Reddit is refusing requests right now. Try again later.', { status: 403 });
      }
      if (res.status === 429) {
        throw new MemeError('rate-limited', 'Reddit is rate-limiting requests. Try again in a minute.', { status: 429 });
      }
      if (!res.ok) throw new MemeError('http', `Reddit returned HTTP ${res.status}.`, { status: res.status });
      // /r/<missing>/hot.json redirects to the subreddit search.
      if (res.redirected && /\/subreddits\/search/.test(res.url)) throw unavailable();

      const json = await readJson(res, 'Reddit');
      if (isSubredditSearchListing(json)) throw unavailable();
      return parseRedditListing(json);
    },
  };
}
