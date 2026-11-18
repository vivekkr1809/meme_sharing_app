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
  'password-required': 'This backup is encrypted. Enter its password to import it.',
  'wrong-password': 'Wrong password. Check it and try again.',
  'weak-password': 'Use at least 8 characters for the backup password.',
  'backup-too-large': 'Your library is too big for one backup file in this browser. Remove some memes and try again.',
  'no-profile': 'Please set your name first.',
  // Codes from the real data layer (src/sync) and meme services (src/memes, MemeError.code).
  'empty-name': 'Please enter a name.',
  'too-long': 'That is too long.',
  'empty-message': 'Type something first.',
  'unknown-meme': "That meme isn't saved on this device.",
  'too-large': 'That file is too big. GIFs can be up to 15 MB.',
  'invalid-mime': "That file isn't an image we can send.",
  'empty-image': "That file isn't an image we can send.",
  'unsupported-type': "That file isn't an image we can send.",
  'decode-failed': "That image couldn't be opened. Try another one.",
  'invalid-subreddit': 'Subreddit names are 2–32 letters, numbers or underscores.',
  'subreddit-unavailable': "That subreddit doesn't exist, or it's private.",
  'network': "Couldn't reach the internet. Check your connection and try again.",
  'rate-limited': 'Reddit is busy right now. Give it a minute and try again.',
  'http': "Couldn't load that right now. Try again in a bit.",
  'bad-response': "Couldn't load that right now. Try again in a bit.",
  'invalid-url': "Couldn't download that image. Try another one.",
  'unsupported-environment': "This browser can't do that. Try a recent Safari or Chrome.",
};

export function errorCode(err: unknown): string {
  // MemeError carries a machine-readable `code`; other services use Error.message as the code.
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
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
  return /subreddit-not-found|subreddit-unavailable|not[- ]?found|404|private|banned|forbidden|403/i.test(errorCode(err));
}
