import { decodePairingCode, encodePairingCode } from '@memes/shared';

/**
 * Finding a pairing code inside scanned or pasted text.
 *
 * A code is 32 Crockford base32 characters, shown as 8 groups of 4 joined by dashes
 * ("7K2M-QX9D-…"). People paste it with words around it ("my code is 7K2M-…, thanks"),
 * with spaces instead of dashes, or as one 32-character block.
 */

const DASHED = /(?<![0-9A-Za-z-])[0-9A-Za-z]{4}(?:-[0-9A-Za-z]{4}){7}(?![0-9A-Za-z-])/g;
/** A run of 4-character groups separated by spaces and/or dashes. */
const GROUP_RUN = /(?<![0-9A-Za-z])[0-9A-Za-z]{4}(?:[-\s]+[0-9A-Za-z]{4})+(?![0-9A-Za-z])/g;
const BLOCK = /(?<![0-9A-Za-z])[0-9A-Za-z]{32}(?![0-9A-Za-z])/g;

/** Plausible codes in `raw`, best first. Not validated. */
export function codeCandidates(raw: string, opts: { allowBlock?: boolean } = {}): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const m of raw.matchAll(DASHED)) add(m[0]);
  for (const m of raw.matchAll(GROUP_RUN)) {
    const groups = m[0].split(/[-\s]+/);
    if (groups.length < 8) continue;
    // A label word that happens to be 4 letters ("code 7K2M …") sits in front, so the last 8 groups come first.
    add(groups.slice(-8).join('-'));
    add(groups.slice(0, 8).join('-'));
  }
  if (opts.allowBlock !== false) for (const m of raw.matchAll(BLOCK)) add(m[0]);
  return out;
}

/** The canonical form ("7K2M-QX9D-…", upper case, O→0, I/L→1) if `candidate` is a valid code. */
export function canonicalCode(candidate: string): string | null {
  const secret = decodePairingCode(candidate);
  return secret ? encodePairingCode(secret) : null;
}

/**
 * Best-effort code from typed or pasted text: the first candidate that decodes (canonicalised),
 * else the first candidate, else the trimmed input (so the pairing service can reject it nicely).
 */
export function extractCode(raw: string): string {
  const candidates = codeCandidates(raw);
  for (const c of candidates) {
    const canon = canonicalCode(c);
    if (canon) return canon;
  }
  return (candidates[0] ?? raw).trim();
}

/**
 * The pairing code carried by a scanned QR value, or null if it isn't a Meme Pals code.
 * Stricter than extractCode: a bare 32-character block only counts when it is the whole
 * content, so a random link with a long id in it is not mistaken for a code.
 */
export function parsePairingQr(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const candidates = codeCandidates(text, { allowBlock: false });
  if (/^[0-9A-Za-z]{32}$/.test(text)) candidates.push(text);
  for (const c of candidates) {
    const canon = canonicalCode(c);
    if (canon) return canon;
  }
  return null;
}

/** First Meme Pals code among several scanned values; `foreign` says whether other QR codes were seen. */
export function pickPairingCode(values: readonly string[]): { code: string | null; foreign: boolean } {
  for (const v of values) {
    const code = parsePairingQr(v);
    if (code) return { code, foreign: false };
  }
  return { code: null, foreign: values.some((v) => v.trim() !== '') };
}
