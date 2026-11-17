/** Map service error codes (Error.message) to friendly copy. */
const MESSAGES: Record<string, string> = {
  'invalid-code': "That code doesn't look right. It should be 32 letters and numbers in groups of four (like 7K2M-QX9D-…).",
  'name-required': 'Please enter a name.',
  'name-too-long': 'That name is a bit long. 40 characters max.',
  'subreddit-not-found': "That subreddit doesn't exist, or it's private.",
  'not-found': "That couldn't be found.",
  'network-error': "Couldn't reach the internet. Check your connection and try again.",
  'fetch-failed': "Couldn't download that image. Try another one.",
  'unsupported-file': "That file isn't an image we can send.",
  'file-too-large': 'That file is too big. GIFs can be up to 15 MB.',
  'meme-not-in-library': "That meme isn't saved on this device.",
  'message-too-long': 'That message is too long.',
  'invalid-backup': "That file isn't a Meme Pals backup.",
  'no-profile': 'Please set your name first.',
};

export function errorCode(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown';
}

export function friendlyError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const code = errorCode(err);
  if (MESSAGES[code]) return MESSAGES[code];
  if (/not[- ]?found|404/i.test(code)) return MESSAGES['not-found']!;
  if (/network|failed to fetch|offline/i.test(code)) return MESSAGES['network-error']!;
  return fallback;
}

/** Real Reddit clients may phrase this differently ("subreddit-not-found", "HTTP 404", "banned", "private"). */
export function isSubredditMissing(err: unknown): boolean {
  return /subreddit-not-found|not[- ]?found|404|private|banned|forbidden|403/i.test(errorCode(err));
}
