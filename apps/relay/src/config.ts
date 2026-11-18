/** ICE server entry as advertised at GET /config (same shape as RTCIceServer). */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):[^\s,]+$/i;

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the ICE server list from environment variables:
 *   STUN_URLS        comma list (default: Google + Cloudflare public STUN; set to "none" to disable)
 *   TURN_URLS        comma list, e.g. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349"
 *   TURN_USERNAME    TURN long-term credential username
 *   TURN_CREDENTIAL  TURN long-term credential password
 * Invalid URLs are dropped (and reported through `warn`, without echoing secrets).
 */
export function iceServersFromEnv(
  env: Record<string, string | undefined>,
  warn: (msg: string) => void = () => {},
): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  const valid = (list: string[], name: string) => {
    const ok = list.filter((u) => ICE_URL_PATTERN.test(u));
    if (ok.length !== list.length) warn(`${name}: ignored ${list.length - ok.length} invalid URL(s)`);
    return ok;
  };

  const stunRaw = env.STUN_URLS?.trim();
  const stun = stunRaw === 'none' ? [] : valid(stunRaw ? splitList(stunRaw) : DEFAULT_STUN_URLS, 'STUN_URLS');
  if (stun.length) servers.push({ urls: stun });

  const turn = valid(splitList(env.TURN_URLS), 'TURN_URLS');
  if (turn.length) {
    const entry: IceServerConfig = { urls: turn };
    if (env.TURN_USERNAME) entry.username = env.TURN_USERNAME;
    if (env.TURN_CREDENTIAL) entry.credential = env.TURN_CREDENTIAL;
    if (!entry.username || !entry.credential) warn('TURN_URLS set without TURN_USERNAME/TURN_CREDENTIAL');
    servers.push(entry);
  }
  return servers;
}
