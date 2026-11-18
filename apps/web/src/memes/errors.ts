/** Error codes surfaced by the meme services. The UI can switch on `code`. */
export type MemeErrorCode =
  /** Subreddit name fails SUBREDDIT_PATTERN, or an unknown sort. */
  | 'invalid-subreddit'
  /** The subreddit doesn't exist, is private, banned or quarantined. */
  | 'subreddit-unavailable'
  /** Every route failed at the network level (offline, CORS, relay down). */
  | 'network'
  /** The upstream (or the relay) rate-limited or blocked us on every route. */
  | 'rate-limited'
  /** Any other non-2xx response. */
  | 'http'
  /** The response wasn't the JSON shape we expected. */
  | 'bad-response'
  /** Image larger than the allowed size. */
  | 'too-large'
  /** The bytes aren't an image format we accept. */
  | 'unsupported-type'
  /** The browser couldn't decode the image. */
  | 'decode-failed'
  /** URL is malformed or uses a scheme we don't fetch. */
  | 'invalid-url'
  /** No canvas / encoder available in this environment. */
  | 'unsupported-environment';

export class MemeError extends Error {
  override readonly name = 'MemeError';
  readonly code: MemeErrorCode;
  /** HTTP status of the last response, when there was one. */
  readonly status?: number;
  /** Extra machine-readable detail (e.g. Reddit's `reason`: "private"). */
  readonly reason?: string;

  constructor(code: MemeErrorCode, message: string, opts: { cause?: unknown; status?: number; reason?: string } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.reason !== undefined) this.reason = opts.reason;
  }
}

export function isMemeError(err: unknown, code?: MemeErrorCode): err is MemeError {
  return err instanceof MemeError && (code === undefined || err.code === code);
}
