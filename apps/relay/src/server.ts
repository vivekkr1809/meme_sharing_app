import { DEFAULT_RELAY_PORT } from '@memes/shared';
import { createRelay, iceServersFromEnv } from './relay';

/**
 * CLI entry. Configuration (all optional):
 *   PORT             listen port (default 8787)
 *   HOST             bind address (default 0.0.0.0)
 *   STATIC_DIR       built web app to serve (e.g. apps/web/dist)
 *   STUN_URLS        comma list (default Google + Cloudflare STUN; "none" disables)
 *   TURN_URLS        comma list of turn:/turns: URLs
 *   TURN_USERNAME    TURN username
 *   TURN_CREDENTIAL  TURN password
 *   TRUST_PROXY      "1" when behind a reverse proxy that sets X-Forwarded-For
 *
 * Logs only lifecycle counts. Never logs room ids, device ids, envelopes or IPs.
 */

const env = process.env;
const log = (msg: string) => console.log(`[relay] ${msg}`);

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_RELAY_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`[relay] invalid PORT`);
    process.exit(1);
  }
  return n;
}

const relay = await createRelay({
  port: parsePort(env.PORT),
  host: env.HOST || '0.0.0.0',
  staticDir: env.STATIC_DIR || undefined,
  iceServers: iceServersFromEnv(env, (m) => log(`warning: ${m}`)),
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  log,
});

log(
  `ready on port ${relay.port}${env.STATIC_DIR ? ' (serving static app)' : ''}` +
    `; turn=${env.TURN_URLS ? 'configured' : 'off'}`,
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 5_000);
  force.unref();
  try {
    await relay.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
