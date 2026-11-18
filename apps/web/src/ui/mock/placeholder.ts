/**
 * Locally generated placeholder meme art (SVG). No network, no external assets:
 * the mock services use these as Reddit posts, Imgflip templates and partner memes.
 */

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const PALETTES: [string, string][] = [
  ['#ffd166', '#ef476f'],
  ['#06d6a0', '#118ab2'],
  ['#a78bfa', '#f472b6'],
  ['#fca311', '#e85d04'],
  ['#90e0ef', '#0077b6'],
  ['#caffbf', '#2a9d8f'],
  ['#ffc6ff', '#7b2cbf'],
  ['#fde68a', '#65a30d'],
  ['#fecaca', '#dc2626'],
  ['#bae6fd', '#6366f1'],
];

const SKINS = ['#ffe0a3', '#ffb4a2', '#b8f2e6', '#cdb4db', '#fefae0', '#a0c4ff', '#ffd6a5', '#d8f3dc'];

export type Ears = 'cat' | 'bear' | 'frog' | 'bunny' | 'none';
export type Face = 'grin' | 'shock' | 'smug' | 'cry' | 'cool' | 'love' | 'flat';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A round cartoon character centred at (cx, cy) with radius r. */
export function character(cx: number, cy: number, r: number, skin: string, ears: Ears, face: Face): string {
  const ink = '#1f1630';
  const sw = Math.max(2, r * 0.07);
  let s = '';
  // Ears
  if (ears === 'cat') {
    s += `<path d="M${cx - r * 0.85} ${cy - r * 0.35} L${cx - r * 0.7} ${cy - r * 1.15} L${cx - r * 0.2} ${cy - r * 0.85} Z" fill="${skin}" stroke="${ink}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    s += `<path d="M${cx + r * 0.85} ${cy - r * 0.35} L${cx + r * 0.7} ${cy - r * 1.15} L${cx + r * 0.2} ${cy - r * 0.85} Z" fill="${skin}" stroke="${ink}" stroke-width="${sw}" stroke-linejoin="round"/>`;
  } else if (ears === 'bear') {
    s += `<circle cx="${cx - r * 0.72}" cy="${cy - r * 0.72}" r="${r * 0.32}" fill="${skin}" stroke="${ink}" stroke-width="${sw}"/>`;
    s += `<circle cx="${cx + r * 0.72}" cy="${cy - r * 0.72}" r="${r * 0.32}" fill="${skin}" stroke="${ink}" stroke-width="${sw}"/>`;
  } else if (ears === 'bunny') {
    s += `<ellipse cx="${cx - r * 0.4}" cy="${cy - r * 1.15}" rx="${r * 0.2}" ry="${r * 0.55}" fill="${skin}" stroke="${ink}" stroke-width="${sw}"/>`;
    s += `<ellipse cx="${cx + r * 0.4}" cy="${cy - r * 1.15}" rx="${r * 0.2}" ry="${r * 0.55}" fill="${skin}" stroke="${ink}" stroke-width="${sw}"/>`;
  } else if (ears === 'frog') {
    s += `<circle cx="${cx - r * 0.5}" cy="${cy - r * 0.8}" r="${r * 0.34}" fill="${skin}" stroke="${ink}" stroke-width="${sw}"/>`;
    s += `<circle cx="${cx + r * 0.5}" cy="${cy - r * 0.8}" r="${r * 0.34}" fill="${skin}" stroke="${ink}" stroke-width="${sw}"/>`;
  }
  // Head
  s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${skin}" stroke="${ink}" stroke-width="${sw}"/>`;
  // Cheeks
  s += `<circle cx="${cx - r * 0.55}" cy="${cy + r * 0.2}" r="${r * 0.13}" fill="#ff8fab" opacity="0.6"/>`;
  s += `<circle cx="${cx + r * 0.55}" cy="${cy + r * 0.2}" r="${r * 0.13}" fill="#ff8fab" opacity="0.6"/>`;
  const ey = ears === 'frog' ? cy - r * 0.8 : cy - r * 0.18;
  const ex = ears === 'frog' ? r * 0.5 : r * 0.36;
  // Eyes
  switch (face) {
    case 'grin':
      s += `<path d="M${cx - ex - r * 0.13} ${ey + r * 0.05} q${r * 0.13} ${-r * 0.2} ${r * 0.26} 0 M${cx + ex - r * 0.13} ${ey + r * 0.05} q${r * 0.13} ${-r * 0.2} ${r * 0.26} 0" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round"/>`;
      break;
    case 'smug':
      s += `<path d="M${cx - ex - r * 0.14} ${ey} h${r * 0.28} M${cx + ex - r * 0.14} ${ey} h${r * 0.28}" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round"/>`;
      s += `<circle cx="${cx - ex + r * 0.06}" cy="${ey + r * 0.06}" r="${r * 0.06}" fill="${ink}"/><circle cx="${cx + ex + r * 0.06}" cy="${ey + r * 0.06}" r="${r * 0.06}" fill="${ink}"/>`;
      break;
    case 'cool':
      s += `<path d="M${cx - r * 0.75} ${ey - r * 0.08} H${cx + r * 0.75} L${cx + r * 0.62} ${ey + r * 0.2} Q${cx + r * 0.36} ${ey + r * 0.32} ${cx + r * 0.12} ${ey + r * 0.12} H${cx - r * 0.12} Q${cx - r * 0.36} ${ey + r * 0.32} ${cx - r * 0.62} ${ey + r * 0.2} Z" fill="${ink}"/>`;
      s += `<path d="M${cx - r * 0.5} ${ey} l${r * 0.12} 0" stroke="#fff" stroke-width="${sw * 0.7}" stroke-linecap="round"/>`;
      break;
    case 'love':
      for (const dx of [-ex, ex]) {
        const hx = cx + dx;
        const k = r * 0.14;
        s += `<path d="M${hx} ${ey + k} C${hx - k * 1.6} ${ey - k * 0.2} ${hx - k * 0.6} ${ey - k * 1.4} ${hx} ${ey - k * 0.4} C${hx + k * 0.6} ${ey - k * 1.4} ${hx + k * 1.6} ${ey - k * 0.2} ${hx} ${ey + k} Z" fill="#ef233c"/>`;
      }
      break;
    default:
      s += `<circle cx="${cx - ex}" cy="${ey}" r="${r * (face === 'shock' ? 0.12 : 0.09)}" fill="${ink}"/>`;
      s += `<circle cx="${cx + ex}" cy="${ey}" r="${r * (face === 'shock' ? 0.12 : 0.09)}" fill="${ink}"/>`;
      if (face === 'shock') {
        s += `<circle cx="${cx - ex + r * 0.04}" cy="${ey - r * 0.04}" r="${r * 0.035}" fill="#fff"/><circle cx="${cx + ex + r * 0.04}" cy="${ey - r * 0.04}" r="${r * 0.035}" fill="#fff"/>`;
      }
  }
  // Mouth
  const my = cy + r * 0.32;
  switch (face) {
    case 'grin':
    case 'love':
      s += `<path d="M${cx - r * 0.34} ${my - r * 0.05} Q${cx} ${my + r * 0.45} ${cx + r * 0.34} ${my - r * 0.05} Z" fill="${ink}"/>`;
      s += `<path d="M${cx - r * 0.16} ${my + r * 0.15} Q${cx} ${my + r * 0.3} ${cx + r * 0.16} ${my + r * 0.15}" fill="#ff6b81"/>`;
      break;
    case 'shock':
      s += `<ellipse cx="${cx}" cy="${my + r * 0.05}" rx="${r * 0.14}" ry="${r * 0.2}" fill="${ink}"/>`;
      break;
    case 'smug':
    case 'cool':
      s += `<path d="M${cx - r * 0.25} ${my} Q${cx + r * 0.05} ${my + r * 0.12} ${cx + r * 0.3} ${my - r * 0.12}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round"/>`;
      break;
    case 'cry':
      s += `<path d="M${cx - r * 0.25} ${my + r * 0.12} Q${cx} ${my - r * 0.12} ${cx + r * 0.25} ${my + r * 0.12}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round"/>`;
      s += `<path d="M${cx - ex} ${ey + r * 0.12} q${-r * 0.08} ${r * 0.3} 0 ${r * 0.38} q${r * 0.08} ${-r * 0.08} 0 ${-r * 0.38}" fill="#4cc9f0"/>`;
      s += `<path d="M${cx + ex} ${ey + r * 0.12} q${-r * 0.08} ${r * 0.3} 0 ${r * 0.38} q${r * 0.08} ${-r * 0.08} 0 ${-r * 0.38}" fill="#4cc9f0"/>`;
      break;
    default:
      s += `<path d="M${cx - r * 0.22} ${my} h${r * 0.44}" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round"/>`;
  }
  return s;
}

function confetti(w: number, h: number, rand: () => number, color: string): string {
  let s = '';
  for (let i = 0; i < 14; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = 3 + rand() * Math.min(w, h) * 0.02;
    s += rand() > 0.5
      ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="0.35"/>`
      : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(r * 2).toFixed(1)}" height="${(r * 0.8).toFixed(1)}" rx="2" fill="${color}" opacity="0.3" transform="rotate(${Math.round(rand() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }
  return s;
}

/** Word-wrap into at most `maxLines` lines of roughly `maxChars` characters. */
function wrap(text: string, maxChars: number, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

/** Impact-style caption lines (local fonts only). */
export function captionSvg(text: string, x: number, y: number, w: number, h: number, anchorBottom = false): string {
  if (!text.trim()) return '';
  const upper = text.toUpperCase();
  let size = Math.min(h * 0.42, w * 0.11);
  let lines = wrap(upper, Math.max(6, Math.floor(w / (size * 0.58))));
  while (lines.length * size * 1.05 > h && size > 10) {
    size *= 0.9;
    lines = wrap(upper, Math.max(6, Math.floor(w / (size * 0.58))));
  }
  const lh = size * 1.05;
  const total = lines.length * lh;
  const startY = anchorBottom ? y + h - total + size * 0.85 : y + size * 0.9;
  const sw = Math.max(2, size * 0.12);
  return lines
    .map(
      (l, i) =>
        `<text x="${(x + w / 2).toFixed(1)}" y="${(startY + i * lh).toFixed(1)}" text-anchor="middle" font-family="Impact, 'Anton', 'Arial Black', 'Helvetica Neue', sans-serif" font-weight="900" font-size="${size.toFixed(1)}" fill="#fff" stroke="#000" stroke-width="${sw.toFixed(1)}" stroke-linejoin="round" paint-order="stroke">${esc(l)}</text>`,
    )
    .join('');
}

export interface MemeArt {
  svg: string;
  width: number;
  height: number;
}

const EARS: Ears[] = ['cat', 'bear', 'frog', 'bunny', 'none'];
const FACES: Face[] = ['grin', 'shock', 'smug', 'cry', 'cool', 'love', 'flat'];
/** Finished memes lean happy. */
const MEME_FACES: Face[] = ['grin', 'grin', 'shock', 'smug', 'smug', 'cool', 'love', 'cry', 'flat'];

/** A finished single-panel meme with top/bottom captions. */
export function memeArt(seed: number, top: string, bottom: string, width = 800, height = 800): MemeArt {
  const rand = rng(seed);
  const [c1, c2] = PALETTES[Math.floor(rand() * PALETTES.length)]!;
  const skin = SKINS[Math.floor(rand() * SKINS.length)]!;
  const ears = EARS[Math.floor(rand() * EARS.length)]!;
  const face = MEME_FACES[Math.floor(rand() * MEME_FACES.length)]!;
  const w = width;
  const h = height;
  const r = Math.min(w, h) * 0.24;
  const gid = `g${seed % 100000}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#${gid})"/>` +
    confetti(w, h, rand, '#ffffff') +
    `<ellipse cx="${w / 2}" cy="${h * 0.5 + r * 1.05}" rx="${r * 0.9}" ry="${r * 0.14}" fill="#000" opacity="0.15"/>` +
    character(w / 2, h * 0.5, r, skin, ears, face) +
    captionSvg(top, w * 0.04, h * 0.02, w * 0.92, h * 0.24) +
    captionSvg(bottom, w * 0.04, h * 0.74, w * 0.92, h * 0.24, true) +
    `</svg>`;
  return { svg, width: w, height: h };
}

/** Blank multi-panel template (no captions) for the meme maker. */
export function templateArt(
  seed: number,
  panels: number,
  width = 800,
  height = 800,
  layout: 'rows' | 'split' = 'rows',
  chars: [Ears, Face][] = [],
): MemeArt {
  const rand = rng(seed);
  const w = width;
  const h = height;
  let body = '';
  for (let i = 0; i < panels; i++) {
    const [c1, c2] = PALETTES[Math.floor(rand() * PALETTES.length)]!;
    const randomSkin = SKINS[Math.floor(rand() * SKINS.length)]!;
    const ears = chars[i]?.[0] ?? EARS[Math.floor(rand() * EARS.length)]!;
    const skin = ears === 'frog' ? '#9be29a' : randomSkin;
    const face = chars[i]?.[1] ?? FACES[(i * 3 + Math.floor(rand() * 2)) % FACES.length]!;
    const gid = `t${seed % 1000}_${i}`;
    let px = 0;
    let py = 0;
    let pw = w;
    let ph = h;
    if (layout === 'rows') {
      ph = h / panels;
      py = i * ph;
    } else {
      pw = w / panels;
      px = i * pw;
    }
    const r = Math.min(pw, ph) * (panels === 1 ? 0.26 : 0.3);
    const cx = layout === 'rows' && panels > 2 ? px + pw * 0.72 : px + pw / 2;
    body +=
      `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
      `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="url(#${gid})"/>` +
      character(cx, py + ph / 2 + (panels === 1 ? 0 : r * 0.1), r, skin, ears, face);
    if (i > 0) {
      body += layout === 'rows'
        ? `<rect x="0" y="${py - 3}" width="${w}" height="6" fill="#1f1630"/>`
        : `<rect x="${px - 3}" y="0" width="6" height="${h}" fill="#1f1630"/>`;
    }
  }
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`,
    width: w,
    height: h,
  };
}

export function svgDataUrl(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function svgBlob(svg: string): Blob {
  return new Blob([svg], { type: 'image/svg+xml' });
}

/** Decode a data: URL (as produced above) into a Blob without touching the network. */
export function dataUrlToBlob(url: string): Blob {
  const m = /^data:([^;,]+)(;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error('not-a-data-url');
  const mime = m[1]!;
  if (m[3]) {
    const bin = atob(m[4]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(m[4]!)], { type: mime });
}
