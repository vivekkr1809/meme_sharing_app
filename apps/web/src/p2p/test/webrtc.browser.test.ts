/**
 * Real WebRTC integration: two Chromium pages (separate browser contexts = separate
 * devices) run the actual transport against the fake relay, served by a Vite dev server.
 *
 * Playwright comes from the environment (NODE_PATH), never from package.json. If it,
 * Chromium, or WebRTC inside Chromium is unavailable, the suite skips with a reason.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ControlFrame, SignedEnvelope } from '@memes/shared';
import type { HarnessApi, HarnessStartOptions } from '../harness/main';
import type { FakeRelay } from './fake-relay';
import { startFakeRelay } from './fake-relay';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
type Browser = any;
type ViteServer = { listen(): Promise<unknown>; close(): Promise<void>; httpServer: any };

const WEB_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SECRET = 'a1'.repeat(20);
const OTHER_SECRET = 'b2'.repeat(20);
const ALICE = 'device-alice-0001';
const BOB = 'device-bob-00002';
const MALLORY = 'device-mallory-03';

const TUNING: HarnessStartOptions['tuning'] = {
  negotiateTimeoutMs: 2500,
  offerFallbackMs: 800,
  probeTimeoutMs: 1500,
  backoff: { baseMs: 150, maxMs: 1500 },
  roomFullDelayMs: 2000,
};

let relay: FakeRelay;
let vite: ViteServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';
let skipReason: string | null = null;
let aliceRoom = '';
const pages: Record<string, Page> = {};

function loadPlaywright(): any {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch (err) {
    return { error: err };
  }
}

/** Can this Chromium open a DataChannel at all (two PCs in one page, host candidates)? */
async function webrtcPreflight(page: Page): Promise<string> {
  return page.evaluate(async () => {
    if (typeof RTCPeerConnection === 'undefined') return 'no RTCPeerConnection';
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const dc = a.createDataChannel('probe');
    const got = new Promise<string>((res) => {
      b.ondatachannel = (e) => (e.channel.onmessage = (m) => res(String(m.data)));
    });
    dc.onopen = () => dc.send('ok');
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription!);
    const r = await Promise.race([got, new Promise<string>((res) => setTimeout(() => res('timeout'), 8000))]);
    a.close();
    b.close();
    return r;
  });
}

async function openPage(name: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e: Error) => console.error(`[${name}] pageerror`, e));
  await page.goto(`${baseUrl}/src/p2p/harness/index.html`);
  await page.waitForFunction(() => !!(window as any).p2p);
  pages[name] = page;
  return page;
}

const call = <K extends keyof HarnessApi>(page: Page, fn: K, ...args: Parameters<HarnessApi[K]>) =>
  page.evaluate(
    ([f, a]: [string, unknown[]]) => (window as any).p2p[f](...a),
    [fn, args],
  ) as Promise<Awaited<ReturnType<HarnessApi[K]>>>;

const startOpts = (deviceId: string, extra: Partial<HarnessStartOptions> = {}): HarnessStartOptions => ({
  secretHex: SECRET,
  relayUrl: relay.url,
  deviceId,
  tuning: TUNING,
  ...extra,
});

async function waitState(page: Page, state: string, timeout = 15_000) {
  try {
    await page.waitForFunction((s: string) => (window as any).p2p.state() === s, state, { timeout, polling: 25 });
  } catch (err) {
    const logs = await call(page, 'logs');
    throw new Error(`state ${state} not reached; logs:\n${logs.slice(-40).join('\n')}\n${String(err)}`);
  }
}

async function waitFrames(page: Page, n: number) {
  await page.waitForFunction((k: number) => (window as any).p2p.frames().length >= k, n, { timeout: 5000, polling: 25 });
  return call(page, 'frames');
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  const pw = loadPlaywright();
  if (pw.error) {
    skipReason = `playwright not resolvable: ${pw.error}`;
    return;
  }
  try {
    browser = await pw.chromium.launch();
  } catch (err) {
    skipReason = `chromium failed to launch: ${err}`;
    return;
  }
  relay = await startFakeRelay();
  const { createServer } = await import('vite');
  vite = (await createServer({
    configFile: false,
    root: WEB_ROOT,
    logLevel: 'error',
    clearScreen: false,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })) as unknown as ViteServer;
  await vite.listen();
  baseUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;

  const probe = await openPage('probe');
  const pre = await webrtcPreflight(probe);
  await probe.context().close();
  if (pre !== 'ok') skipReason = `Chromium could not open a loopback DataChannel (${pre})`;
}, 60_000);

afterAll(async () => {
  if (process.env.P2P_DEBUG) {
    for (const [name, page] of Object.entries(pages)) {
      if (!page.isClosed()) console.info(`--- ${name} ---\n` + (await call(page, 'logs')).join('\n'));
    }
  }
  await browser?.close();
  await vite?.close();
  await relay?.close();
}, 30_000);

describe('real WebRTC in Chromium', () => {
  const live = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
    it(
      name,
      async (ctx) => {
        if (skipReason) {
          console.warn(`[webrtc.browser] SKIPPED: ${skipReason}`);
          ctx.skip();
        }
        await fn();
      },
      timeout,
    );

  live('two devices with the same secret connect', async () => {
    const a = await openPage('alice');
    const b = await openPage('bob');
    aliceRoom = await call(a, 'start', startOpts(ALICE));
    await waitState(a, 'waiting');
    await call(b, 'start', startOpts(BOB));
    await waitState(a, 'connected');
    await waitState(b, 'connected');
    // waiting → connecting (negotiating) → connected
    expect(await call(a, 'states')).toEqual(['connecting', 'waiting', 'connecting', 'connected']);
    expect(await call(b, 'states')).toEqual(['connecting', 'connected']);
    // Everything that went through the relay was a signed envelope; no plaintext SDP.
    expect(relay.forwarded.length).toBeGreaterThan(1);
    for (const f of relay.forwarded) expect(Object.keys(f.envelope).sort()).toEqual(['mac', 'payload']);
  });

  live('control frames flow both ways; invalid ones are dropped', async () => {
    const { alice: a, bob: b } = pages;
    const typing: ControlFrame = { type: 'typing', active: true };
    const hello: ControlFrame = { type: 'hello', v: 1, deviceId: BOB, displayName: 'Bob', lastReceivedId: null, lastReadId: null };
    expect(await call(a, 'send', typing)).toBe(true);
    expect(await call(b, 'send', hello)).toBe(true);
    expect(await waitFrames(b, 1)).toEqual([typing]);
    expect(await waitFrames(a, 1)).toEqual([hello]);

    await call(a, 'sendRawText', '{"type":"typing","active":"yes"}');
    await call(a, 'sendRawText', 'garbage');
    await call(a, 'send', { type: 'read', upToId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' });
    const got = await waitFrames(b, 2);
    expect(got).toEqual([typing, { type: 'read', upToId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' }]);
  });

  live('a 5 MB blob arrives intact (sha256 matches)', async () => {
    const { alice: a, bob: b } = pages;
    const size = 5 * 1024 * 1024;
    const sent = await call(a, 'sendRandomBlob', size);
    expect(sent.ok).toBe(true);
    await b.waitForFunction(() => (window as any).p2p.blobs().length >= 1, null, { timeout: 15_000 });
    const [blob] = await call(b, 'blobs');
    expect(blob).toEqual({ memeId: sent.memeId, mime: 'image/png', size, sha: sent.memeId });
    console.info(`[webrtc.browser] 5 MB sendBlob resolved in ${Math.round(sent.ms)} ms`);

    // And the other way, smaller.
    const back = await call(b, 'sendRandomBlob', 300_000);
    expect(back.ok).toBe(true);
    await a.waitForFunction(() => (window as any).p2p.blobs().length >= 1, null, { timeout: 10_000 });
    expect((await call(a, 'blobs'))[0]!.sha).toBe(back.memeId);
  });

  live('a relay-only drop keeps the DataChannel connected', async () => {
    const { alice: a, bob: b } = pages;
    const statesA = (await call(a, 'states')).length;
    const statesB = (await call(b, 'states')).length;
    const joins = relay.joins.length;
    relay.kick(ALICE);
    // Alice rejoins in the background; Bob sees peer-left then peer-joined and probes the channel.
    for (let i = 0; i < 100 && relay.joins.length === joins; i++) await sleep(50);
    expect(relay.joins.length).toBe(joins + 1);
    await sleep(TUNING!.probeTimeoutMs! + 500);
    expect(await call(a, 'states')).toHaveLength(statesA);
    expect(await call(b, 'states')).toHaveLength(statesB);
    expect(await call(a, 'state')).toBe('connected');
    const n = (await call(b, 'frames')).length;
    await call(a, 'send', { type: 'typing', active: false });
    expect((await waitFrames(b, n + 1)).at(-1)).toEqual({ type: 'typing', active: false });
  });

  live('reconnects after one page reloads', async () => {
    const { alice: a, bob: b } = pages;
    await b.reload();
    await b.waitForFunction(() => !!(window as any).p2p);
    await call(b, 'start', startOpts(BOB));
    await waitState(b, 'connected');
    await waitState(a, 'connected');
    await call(b, 'send', { type: 'profile', displayName: 'Bob again' });
    expect((await call(a, 'frames')).length).toBeGreaterThan(0);
    await a.waitForFunction(() => (window as any).p2p.frames().some((f: any) => f.displayName === 'Bob again'), null, {
      timeout: 5000,
    });
    // Alice's states went through a reconnect and settled back on connected.
    const states = await call(a, 'states');
    expect(states.at(-1)).toBe('connected');
    expect(states.filter((s) => s === 'connected').length).toBeGreaterThanOrEqual(2);
  });

  live('a device with a different secret cannot connect, even in the same relay room', async () => {
    const { alice: a, bob: b } = pages;
    await call(b, 'stop');
    await waitState(a, 'waiting');
    // Mallory knows (or the relay leaks) Alice's room id, but not the pairing secret.
    expect(relay.members(aliceRoom)).toEqual([ALICE]);
    const m = await openPage('mallory');
    await call(m, 'start', startOpts(MALLORY, { secretHex: OTHER_SECRET, roomIdOverride: aliceRoom }));
    await sleep(4000); // several offer / fallback / watchdog rounds
    expect(await call(m, 'states')).not.toContain('connected');
    expect((await call(a, 'states')).at(-1)).not.toBe('connected');
    expect((await call(a, 'logs')).some((l) => l.includes('verification failed'))).toBe(true);
    expect((await call(m, 'logs')).some((l) => l.includes('verification failed'))).toBe(true);
    await call(m, 'stop');
    await m.context().close();
    await waitState(a, 'waiting');
  });

  live('tampered and replayed envelopes are rejected; recovery once the relay behaves', async () => {
    const { alice: a, bob: b } = pages;
    const flip = (env: SignedEnvelope): SignedEnvelope => {
      // Swap two characters of the SDP/ICE payload while keeping the MAC.
      const p = env.payload.replace(/"sdp":"v=0/, '"sdp":"v=1').replace(/candidate:(\d)/, (_, d) => `candidate:${(+d + 1) % 10}`);
      return { payload: p === env.payload ? env.payload + ' ' : p, mac: env.mac };
    };
    relay.opts.tamper = flip;
    const before = (await call(a, 'logs')).filter((l) => l.includes('verification failed')).length;
    await call(b, 'restart');
    await sleep(3000);
    expect((await call(a, 'state')) === 'connected' || (await call(b, 'state')) === 'connected').toBe(false);
    const after = (await call(a, 'logs')).filter((l) => l.includes('verification failed')).length;
    expect(after).toBeGreaterThan(before);

    // Replay: the relay re-sends genuine, previously accepted envelopes.
    relay.opts.tamper = undefined;
    const old = relay.forwarded.filter((f) => f.from === BOB && !f.envelope.payload.endsWith(' ')).slice(0, 3);
    expect(old.length).toBeGreaterThan(0);
    for (const f of old) relay.inject(ALICE, { type: 'signal', envelope: f.envelope });
    await a.waitForFunction(
      (n: number) => (window as any).p2p.logs().filter((l: string) => l.includes('verification failed')).length >= n,
      after + old.length,
      { timeout: 5000 },
    );

    // Honest relay again: the negotiation watchdog recovers on its own.
    await waitState(a, 'connected', 20_000);
    await waitState(b, 'connected', 20_000);
  }, 40_000);

  live('a second tab of the same device takes over; the first goes idle and stays idle', async () => {
    const { alice: a, bob: oldBob } = pages;
    const tab2 = await openPage('bob-tab2');
    await call(tab2, 'start', startOpts(BOB));
    await waitState(oldBob, 'idle');
    expect((await call(oldBob, 'logs')).some((l) => l.includes('superseded'))).toBe(true);
    await waitState(tab2, 'connected');
    await waitState(a, 'connected');
    await sleep(500);
    expect(await call(oldBob, 'state')).toBe('idle');
    pages.bob = tab2;
    await oldBob.context().close();
  });

  live('sendBlob rejects when the connection drops mid-transfer; stop() → idle; start() works again', async () => {
    const { alice: a, bob: b } = pages;
    const res = await call(a, 'sendRandomBlob', 14 * 1024 * 1024, { stopAfterMs: 5 });
    expect(res.ok).toBe(false);
    expect(await call(a, 'state')).toBe('idle');
    expect(await call(a, 'send', { type: 'typing', active: true })).toBe(false);
    await waitState(b, 'waiting');
    await call(a, 'restart');
    await waitState(a, 'connected');
    await waitState(b, 'connected');
  });
});
