import { makePng, sha256Hex } from './images';

/**
 * Mocked meme upstreams (Reddit, Imgflip, image CDNs). The same fixtures answer
 *   - the browser's direct requests (via context.route), and
 *   - the relay's proxy requests (via createRelay({ fetchImpl })).
 * Nothing here touches the real internet.
 */

export const MEME_HOSTS = ['www.reddit.com', 'api.imgflip.com', 'i.redd.it', 'preview.redd.it', 'i.imgflip.com'] as const;

export interface FixtureImage {
  url: string;
  bytes: Buffer;
  sha256: string;
}

function image(url: string, w: number, h: number, seed: number): FixtureImage {
  const bytes = makePng(w, h, seed);
  return { url, bytes, sha256: sha256Hex(bytes) };
}

export interface FixturePost {
  id: string;
  title: string;
  image: FixtureImage;
  thumb: FixtureImage;
  nsfw?: boolean;
}

export const POSTS: FixturePost[] = [
  { id: 'e2e001', title: 'When the tests pass on the first try', image: image('https://i.redd.it/e2epost001.png', 320, 240, 1), thumb: image('https://preview.redd.it/e2epost001.png?width=160', 160, 120, 101) },
  { id: 'e2e002', title: 'Me explaining WebRTC to my cat', image: image('https://i.redd.it/e2epost002.png', 300, 300, 2), thumb: image('https://preview.redd.it/e2epost002.png?width=160', 160, 160, 102) },
  { id: 'e2e003', title: 'Monday mood', image: image('https://i.redd.it/e2epost003.png', 240, 320, 3), thumb: image('https://preview.redd.it/e2epost003.png?width=160', 120, 160, 103) },
  { id: 'e2e004', title: 'Definitely not safe for work', image: image('https://i.redd.it/e2epost004.png', 200, 200, 4), thumb: image('https://preview.redd.it/e2epost004.png?width=160', 100, 100, 104), nsfw: true },
];

export const TEMPLATES = [
  { id: '9001', name: 'E2E Drake', image: image('https://i.imgflip.com/e2edrake.png', 400, 400, 11), boxCount: 2 },
  { id: '9002', name: 'E2E Two Buttons', image: image('https://i.imgflip.com/e2ebuttons.png', 300, 450, 12), boxCount: 3 },
];

const IMAGES = new Map<string, FixtureImage>();
for (const p of POSTS) {
  IMAGES.set(p.image.url, p.image);
  IMAGES.set(p.thumb.url, p.thumb);
}
for (const t of TEMPLATES) IMAGES.set(t.image.url, t.image);

function redditListing(sub: string) {
  return {
    kind: 'Listing',
    data: {
      after: null,
      children: POSTS.map((p, i) => ({
        kind: 't3',
        data: {
          id: p.id,
          name: `t3_${p.id}`,
          title: p.title,
          subreddit: sub,
          author: `e2e_user_${i}`,
          score: 1000 - i * 10,
          permalink: `/r/${sub}/comments/${p.id}/x/`,
          url: p.image.url,
          url_overridden_by_dest: p.image.url,
          post_hint: 'image',
          is_self: false,
          is_video: false,
          over_18: !!p.nsfw,
          spoiler: false,
          created_utc: 1_760_000_000 + i,
          preview: {
            images: [
              {
                source: { url: p.image.url, width: 320, height: 240 },
                resolutions: [{ url: p.thumb.url, width: 160, height: 120 }],
              },
            ],
          },
        },
      })),
    },
  };
}

const IMGFLIP = {
  success: true,
  data: {
    memes: TEMPLATES.map((t) => ({ id: t.id, name: t.name, url: t.image.url, width: 400, height: 400, box_count: t.boxCount })),
  },
};

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Answer a request to a mocked meme host, or null if the URL isn't one we know. */
export function upstreamFor(rawUrl: string): UpstreamResponse | null {
  const u = new URL(rawUrl);
  if (u.hostname === 'www.reddit.com') {
    const m = /^\/r\/([A-Za-z0-9_]+)\/(hot|new|top|rising)\.json$/.exec(u.pathname);
    if (!m) return { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":404}') };
    if (m[1]!.toLowerCase() === 'doesnotexist') {
      return { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"reason":"banned","error":404}') };
    }
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(redditListing(m[1]!))) };
  }
  if (u.hostname === 'api.imgflip.com' && u.pathname === '/get_memes') {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(IMGFLIP)) };
  }
  const img = IMAGES.get(u.href);
  if (img) return { status: 200, headers: { 'content-type': 'image/png' }, body: img.bytes };
  if ((MEME_HOSTS as readonly string[]).includes(u.hostname)) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
  }
  return null;
}

/** What the relay's proxies asked "upstream" for (proves the proxy route was used). */
export const relayUpstreamLog: string[] = [];

/** `fetchImpl` for createRelay: serves the fixtures, refuses everything else. */
export const relayFetch: typeof fetch = async (input, _init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  relayUpstreamLog.push(url);
  const r = upstreamFor(url);
  if (!r) throw new TypeError(`e2e: relay tried to reach an unmocked upstream: ${url}`);
  return new Response(new Uint8Array(r.body), { status: r.status, headers: r.headers });
};
