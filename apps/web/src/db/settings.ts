import { SUBREDDIT_PATTERN } from '@memes/shared';
import { DEFAULT_SETTINGS, type Settings } from '../contracts';

const THEMES = new Set(['system', 'light', 'dark']);

/** Keep only well-formed settings fields from untrusted input (UI patch or backup file). */
export function sanitizeSettings(x: unknown): Partial<Settings> {
  if (typeof x !== 'object' || x === null) return {};
  const s = x as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (typeof s.relayUrl === 'string') out.relayUrl = s.relayUrl.trim();
  if (Array.isArray(s.subreddits)) {
    out.subreddits = [...new Set(s.subreddits.filter((v): v is string => typeof v === 'string' && SUBREDDIT_PATTERN.test(v)))];
  }
  if (typeof s.theme === 'string' && THEMES.has(s.theme)) out.theme = s.theme as Settings['theme'];
  if (typeof s.hideNsfw === 'boolean') out.hideNsfw = s.hideNsfw;
  return out;
}

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, subreddits: [...DEFAULT_SETTINGS.subreddits], ...sanitizeSettings(stored) };
}
