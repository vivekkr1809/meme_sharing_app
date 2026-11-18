import { describe, expect, it } from 'vitest';
import { friendlyError, isSubredditMissing } from './errors';
import { backupFileName, dayLabel, formatScore, redditUrl } from './format';
import { extractCode } from './screens/Pairing';
import { cleanSubreddit, validateRelayUrl } from './screens/Settings';

describe('ui helpers', () => {
  it('cleans and validates subreddit names like SUBREDDIT_PATTERN', () => {
    expect(cleanSubreddit('r/memes')).toBe('memes');
    expect(cleanSubreddit(' /r/Programmer_Humor/ ')).toBe('Programmer_Humor');
    expect(cleanSubreddit('a')).toBeNull();
    expect(cleanSubreddit('has space')).toBeNull();
    expect(cleanSubreddit('x'.repeat(33))).toBeNull();
  });

  it('validates relay URLs (blank = same origin)', () => {
    expect(validateRelayUrl('')).toBeNull();
    expect(validateRelayUrl('relay.example.com')).toBeNull();
    expect(validateRelayUrl('http://localhost:8787')).toBeNull();
    expect(validateRelayUrl('ftp://x.y')).toMatch(/http/);
    expect(validateRelayUrl('http://')).toBeTruthy();
  });

  it('extracts a pairing code from scanned text', () => {
    const code = '7K2M-QX9D-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01';
    expect(extractCode(code)).toBe(code);
    expect(extractCode(`https://example.com/pair#${code}`)).toBe(code);
    expect(extractCode('  something else ')).toBe('something else');
  });

  it('formats dates, scores, filenames and links', () => {
    const now = new Date(2026, 10, 17, 12).getTime();
    expect(dayLabel(now - 3600_000, now)).toBe('Today');
    expect(dayLabel(now - 86400_000, now)).toBe('Yesterday');
    expect(backupFileName(new Date(2026, 0, 5))).toBe('meme-pals-backup-2026-01-05.json');
    expect(formatScore(950)).toBe('950');
    expect(formatScore(1234)).toBe('1.2k');
    expect(formatScore(25_400)).toBe('25k');
    expect(redditUrl('/r/memes/comments/x/')).toBe('https://www.reddit.com/r/memes/comments/x/');
    expect(redditUrl('https://redd.it/x')).toBe('https://redd.it/x');
  });

  it('maps error codes to friendly messages', () => {
    expect(friendlyError(new Error('invalid-code'))).toMatch(/doesn't look right/);
    expect(friendlyError(new Error('weird'))).toMatch(/Something went wrong/);
    expect(isSubredditMissing(new Error('HTTP 404'))).toBe(true);
    expect(isSubredditMissing(new Error('network-error'))).toBe(false);
  });
});
