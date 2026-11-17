import type {
  CaptionBox,
  ImageTools,
  ImgflipSource,
  MemeServices,
  MemeTemplate,
  ProcessedImage,
  RedditPage,
  RedditPost,
  RedditSource,
} from '../../contracts';
import { captionSvg, dataUrlToBlob, hashString, memeArt, rng, svgBlob, svgDataUrl, templateArt, type Ears, type Face } from './placeholder';

/** Pairs of top/bottom captions for the fake Reddit feed. All original. */
export const CAPTIONS: [string, string][] = [
  ["me: I'll sleep early tonight", 'also me at 3am: one more video'],
  ['when the code works', 'and you have no idea why'],
  ['my plants after I water them', 'once a month'],
  ['"5 minute walk"', 'google maps: 47 minutes'],
  ['me opening the fridge', 'for the 9th time in an hour'],
  ['when someone says', '"we need to talk"'],
  ['the group chat at 2am', 'philosophers, all of them'],
  ['me pretending to understand', 'the instructions'],
  ['monday morning', 'loading... please wait'],
  ['when your food arrives', 'and it actually looks like the picture'],
  ['my bank account', 'after one coffee'],
  ['nobody:', 'my cat at 4am: zoomies'],
  ['me: has 37 tabs open', 'my laptop: I am a jet engine now'],
  ['when the wifi', 'reconnects'],
  ['when you hear your name', 'in a conversation across the room'],
  ['me after one push-up', 'time to rest for a week'],
  ['when the weekend', 'is finally here'],
  ['me explaining a meme', 'that was funny 5 seconds ago'],
  ['the last slice', 'of pizza'],
  ['when you finally', 'find the perfect meme to send'],
  ['me watching my partner', 'eat my fries'],
  ['when the delivery', 'says "arriving today"'],
  ['me in the shower', 'winning arguments from 2014'],
  ['my brain when I try to sleep', 'remember that thing from school?'],
];

const TITLES = [
  'Every single time',
  'This is me and I am this',
  'Too accurate',
  'Why is this so real',
  'Made this at lunch',
  'My partner sent me this, had to share',
  'Felt this one',
  'The duality of man',
  'Happens every weekend',
  'Me_irl',
  'Certified moment',
  'I feel attacked',
  'Day 3 of posting until it gets a laugh',
  'Not me doing this again',
  'Scientists hate this one trick',
  'Accidentally relatable',
];

const AUTHORS = ['pixel_pan', 'cozy_otter', 'snackwizard', 'moss_and_tea', 'sleepy_byte', 'gravyboat9', 'lunar_noodle', 'tofu_tactics'];

const RATIOS: [number, number][] = [
  [800, 800],
  [800, 1000],
  [800, 640],
  [800, 1100],
  [800, 800],
  [800, 900],
];

const PAGE_SIZE = 12;
const PAGES = 3;

export interface MockMemeOptions {
  /** Multiplies artificial latency. 0 in tests. */
  timeScale?: number;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makePost(sub: string, sort: string, page: number, i: number, now: number): RedditPost {
  const seed = hashString(`${sub.toLowerCase()}:${sort}:${page}:${i}`);
  const rand = rng(seed);
  const [top, bottom] = CAPTIONS[Math.floor(rand() * CAPTIONS.length)]!;
  const [w, h] = RATIOS[Math.floor(rand() * RATIOS.length)]!;
  const art = memeArt(seed, top, bottom, w, h);
  const url = svgDataUrl(art.svg);
  const id = `t3_${(seed % 1e8).toString(36)}${page}${i}`;
  return {
    id,
    title: TITLES[Math.floor(rand() * TITLES.length)]!,
    subreddit: sub,
    author: AUTHORS[Math.floor(rand() * AUTHORS.length)]!,
    score: Math.floor(rand() * (sort === 'top' ? 90000 : 25000)) + 12,
    permalink: `/r/${sub}/comments/${id.slice(3)}/demo_post/`,
    imageUrl: url,
    thumbUrl: url,
    width: w,
    height: h,
    nsfw: rand() < 0.12,
    createdAt: now - (page * PAGE_SIZE + i) * 47 * 60_000,
  };
}

export function createMockReddit(opts: MockMemeOptions = {}): RedditSource {
  const scale = opts.timeScale ?? 1;
  return {
    async fetchPage(subreddit, o = {}) {
      await delay(700 * scale);
      const sub = subreddit.replace(/^r\//i, '');
      const lower = sub.toLowerCase();
      if (lower === 'doesnotexist' || lower.startsWith('nope')) throw new Error('subreddit-not-found');
      if (lower === 'offline') throw new Error('network-error');
      if (lower.startsWith('empty')) return { posts: [], after: null };
      const page = o.after ? Number(o.after.replace(/^p/, '')) || 0 : 0;
      const sort = o.sort ?? 'hot';
      const now = Date.now();
      const posts = Array.from({ length: PAGE_SIZE }, (_, i) => makePost(sub, sort, page, i, now));
      const page2: RedditPage = { posts, after: page + 1 < PAGES ? `p${page + 1}` : null };
      return page2;
    },
  };
}

interface TemplateDef {
  name: string;
  panels: number;
  layout: 'rows' | 'split';
  boxes: number;
  w: number;
  h: number;
  chars: [Ears, Face][];
}

const TEMPLATE_DEFS: TemplateDef[] = [
  { name: 'Surprised Blob', panels: 1, layout: 'rows', boxes: 2, w: 800, h: 800, chars: [['none', 'shock']] },
  { name: 'Before / After', panels: 2, layout: 'rows', boxes: 2, w: 700, h: 900, chars: [['bear', 'flat'], ['bear', 'love']] },
  { name: 'Brain Levels', panels: 4, layout: 'rows', boxes: 4, w: 700, h: 1000, chars: [['none', 'flat'], ['none', 'smug'], ['none', 'grin'], ['none', 'cool']] },
  { name: 'Left or Right', panels: 2, layout: 'split', boxes: 2, w: 900, h: 600, chars: [['cat', 'shock'], ['cat', 'cool']] },
  { name: 'Smug Frog', panels: 1, layout: 'rows', boxes: 2, w: 800, h: 800, chars: [['frog', 'smug']] },
  { name: 'Three Stages', panels: 3, layout: 'rows', boxes: 3, w: 700, h: 900, chars: [['bunny', 'flat'], ['bunny', 'shock'], ['bunny', 'cry']] },
  { name: 'Cool Bear', panels: 1, layout: 'rows', boxes: 2, w: 800, h: 700, chars: [['bear', 'cool']] },
  { name: 'Sad Bunny', panels: 1, layout: 'rows', boxes: 1, w: 800, h: 800, chars: [['bunny', 'cry']] },
  { name: 'Love Struck', panels: 1, layout: 'rows', boxes: 2, w: 800, h: 800, chars: [['cat', 'love']] },
  { name: 'Cat Judges You', panels: 1, layout: 'rows', boxes: 2, w: 800, h: 900, chars: [['cat', 'flat']] },
  { name: 'Panic Mode', panels: 2, layout: 'split', boxes: 2, w: 900, h: 600, chars: [['frog', 'flat'], ['frog', 'shock']] },
  { name: 'Plain Stare', panels: 1, layout: 'rows', boxes: 1, w: 800, h: 800, chars: [['none', 'flat']] },
];

const layouts = new Map<string, TemplateDef>();

export function createMockImgflip(opts: MockMemeOptions = {}): ImgflipSource {
  const scale = opts.timeScale ?? 1;
  let cache: MemeTemplate[] | null = null;
  return {
    async listTemplates() {
      await delay(500 * scale);
      if (!cache) {
        cache = TEMPLATE_DEFS.map((d, i) => {
          const id = String(100000 + i * 7919);
          layouts.set(id, d);
          const art = templateArt(hashString(d.name), d.panels, d.w, d.h, d.layout, d.chars);
          return { id, name: d.name, url: svgDataUrl(art.svg), width: d.w, height: d.h, boxCount: d.boxes };
        });
      }
      return cache;
    },
  };
}

export function defaultBoxesFor(t: MemeTemplate): CaptionBox[] {
  const def = layouts.get(t.id);
  const n = Math.max(1, t.boxCount);
  if (def?.layout === 'split') {
    return Array.from({ length: n }, (_, i) => ({ text: '', x: i / n + 0.02, y: 0.03, width: 1 / n - 0.04, height: 0.3 }));
  }
  if (n === 1) return [{ text: '', x: 0.04, y: 0.75, width: 0.92, height: 0.22 }];
  if (n === 2) {
    return [
      { text: '', x: 0.04, y: 0.02, width: 0.92, height: 0.22 },
      { text: '', x: 0.04, y: 0.76, width: 0.92, height: 0.22 },
    ];
  }
  return Array.from({ length: n }, (_, i) => ({ text: '', x: 0.03, y: i / n + 0.02, width: 0.5, height: 1 / n - 0.04 }));
}

// ─── Canvas helpers (browser) with an SVG fallback (jsdom/tests) ────────────

export function canUseCanvas(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  if (/jsdom/i.test(navigator.userAgent)) return false;
  return typeof HTMLCanvasElement !== 'undefined';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image-load-failed'));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/webp', quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else canvas.toBlob((p) => (p ? resolve(p) : reject(new Error('encode-failed'))), 'image/png');
      },
      type,
      quality,
    );
  });
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Draw Impact-style captions on a canvas context, fitting each box. */
export function drawCaptions(ctx: CanvasRenderingContext2D, W: number, H: number, boxes: CaptionBox[]) {
  for (const b of boxes) {
    const raw = b.uppercase === false ? b.text : b.text.toUpperCase();
    if (!raw.trim()) continue;
    const bw = b.width * W;
    const bh = b.height * H;
    let size = Math.min(bh * 0.5, W * 0.1);
    let lines: string[] = [];
    for (; size > 10; size *= 0.92) {
      ctx.font = `900 ${size}px Impact, Anton, "Arial Black", "Helvetica Neue", sans-serif`;
      lines = wrapLines(ctx, raw, bw);
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      if (lines.length * size * 1.08 <= bh && widest <= bw) break;
    }
    const lh = size * 1.08;
    const bottomish = b.y > 0.5;
    const startY = bottomish ? b.y * H + bh - lines.length * lh + size * 0.88 : b.y * H + size * 0.92;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.14);
    ctx.strokeStyle = b.outlineColor ?? '#000';
    ctx.fillStyle = b.color ?? '#fff';
    lines.forEach((l, i) => {
      const x = b.x * W + bw / 2;
      const y = startY + i * lh;
      ctx.strokeText(l, x, y);
      ctx.fillText(l, x, y);
    });
  }
}

function svgSize(svg: string): { width: number; height: number } {
  const m = /width="(\d+(?:\.\d+)?)"\s+height="(\d+(?:\.\d+)?)"/.exec(svg);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 800, height: 800 };
}

export function createMockImageTools(opts: MockMemeOptions = {}): ImageTools {
  const scale = opts.timeScale ?? 1;
  return {
    async fetchImage(url) {
      await delay(400 * scale);
      if (!url.startsWith('data:')) throw new Error('fetch-failed');
      const blob = dataUrlToBlob(url);
      const size = blob.type === 'image/svg+xml' ? svgSize(await blob.text()) : { width: 800, height: 800 };
      return { blob, mime: blob.type, ...size };
    },

    async processUpload(file) {
      if (!file.type.startsWith('image/')) throw new Error('unsupported-file');
      if (file.type === 'image/gif') {
        if (file.size > 15 * 1024 * 1024) throw new Error('file-too-large');
        return { blob: file, mime: 'image/gif', width: 480, height: 480 };
      }
      if (!canUseCanvas()) return { blob: file, mime: file.type, width: 1080, height: 1080 };
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k));
        const h = Math.max(1, Math.round(img.naturalHeight * k));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')!.drawImage(img, 0, 0, w, h);
        const blob = await canvasToBlob(c);
        return { blob, mime: blob.type, width: w, height: h };
      } finally {
        URL.revokeObjectURL(url);
      }
    },

    async renderMeme(template, boxes): Promise<ProcessedImage> {
      const W = template.width;
      const H = template.height;
      if (canUseCanvas()) {
        const img = await loadImage(template.url);
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0, W, H);
        drawCaptions(ctx, W, H, boxes);
        const blob = await canvasToBlob(c);
        return { blob, mime: blob.type, width: W, height: H };
      }
      // jsdom / no canvas: compose an SVG that embeds the template.
      const text = boxes
        .map((b) => captionSvg(b.text, b.x * W, b.y * H, b.width * W, b.height * H, b.y > 0.5))
        .join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><image href="${template.url.replace(/"/g, '&quot;')}" width="${W}" height="${H}"/>${text}</svg>`;
      return { blob: svgBlob(svg), mime: 'image/svg+xml', width: W, height: H };
    },

    defaultBoxes: defaultBoxesFor,
  };
}

export function createMockMemeServices(opts: MockMemeOptions = {}): MemeServices {
  return {
    reddit: createMockReddit(opts),
    imgflip: createMockImgflip(opts),
    images: createMockImageTools(opts),
  };
}
