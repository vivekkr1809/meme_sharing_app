/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armFsGuard, fromRelay, type FsGuard } from '../support/fsguard';
import {
  bubble,
  goTab,
  idbAll,
  imgSha256,
  pairedDevices,
  ROOT,
  sendText,
  startEnv,
  T,
  token,
  waitBubble,
  type Device,
  type Env,
} from '../support/harness';
import { leakSignatures } from '../support/images';
import { MEME_HOSTS, POSTS, relayUpstreamLog, TEMPLATES } from '../support/upstream';

/**
 * Privacy: run a full session (pair, chat, react, type, memes from every source, both
 * meme routes) while recording every HTTP request and relay WebSocket frame from both
 * phones and every fs write made by the relay, then check that nothing personal leaked.
 */

let env: Env;
let guard: FsGuard;
let a: Device;
let b: Device;
const secrets: string[] = [];
const memeBytes: Buffer[] = [];
let pairingSecrets: string[] = [];

beforeAll(async () => {
  guard = armFsGuard(ROOT);
  env = await startEnv();
  relayUpstreamLog.length = 0;
  [a, b] = await pairedDevices(env, [token('Priya'), token('Quentin')]);
  secrets.push(a.name, b.name);

  // Chat both ways, with a reply, a reaction and typing.
  const t1 = token('my-secret-crush-is-');
  const t2 = token('meet-me-at-the-pier-');
  secrets.push(t1, t2);
  await sendText(a.page, t1);
  await waitBubble(b.page, t1);
  await b.page.getByRole('textbox', { name: 'Message' }).fill(t2);
  await a.page.getByRole('status', { name: `${b.name} is typing` }).waitFor({ timeout: T.sync });
  await b.page.getByRole('textbox', { name: 'Message' }).press('Enter');
  await waitBubble(a.page, t2);
  await bubble(a.page, t2).locator('.bubble').click({ button: 'right' });
  await a.page.getByRole('toolbar', { name: 'Message actions' }).getByRole('button', { name: 'React with ❤️' }).click();
  await bubble(b.page, t2).getByRole('button', { name: '❤️ 1', exact: true }).waitFor({ timeout: T.sync });

  // Reddit meme over the direct route (A) and the relay proxy (B).
  b.memeRoute = 'blocked';
  for (const [from, to, post] of [
    [a, b, POSTS[0]!],
    [b, a, POSTS[1]!],
  ] as const) {
    await goTab(from.page, 'Discover');
    await from.page.getByRole('button', { name: post.title, exact: true }).click();
    await from.page.getByRole('button', { name: `Send to ${to.name}` }).click();
    const img = to.page.getByRole('list', { name: 'Messages' }).getByRole('img', { name: post.title, exact: true });
    expect(await imgSha256(to.page, img)).toBe(post.image.sha256);
    memeBytes.push(post.image.bytes);
  }

  // An upload (bytes generated in the page, so they never exist on any server).
  await goTab(a.page, 'Chat');
  const jpeg: number[] = await a.page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 200;
    const g = c.getContext('2d')!;
    for (let i = 0; i < 300; i += 10) {
      g.fillStyle = `hsl(${i}, 80%, 50%)`;
      g.fillRect(i, 0, 10, 200);
    }
    const blob: Blob = await new Promise((r) => c.toBlob((x) => r(x!), 'image/jpeg', 0.92));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  memeBytes.push(Buffer.from(jpeg));
  await a.page.locator('form.composer input[type=file]').setInputFiles({ name: 'private-photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg) });
  await b.page.getByRole('list', { name: 'Messages' }).getByRole('img', { name: 'private-photo', exact: true }).waitFor({ timeout: T.sync });

  // A captioned meme (template via the proxy on B).
  const caption = token('caption-only-we-know-');
  secrets.push(caption);
  await goTab(b.page, 'Make');
  await b.page.getByRole('list', { name: 'Templates' }).getByRole('button', { name: TEMPLATES[1]!.name }).click();
  await b.page.getByLabel('Text 1').fill(caption);
  await b.page.getByRole('button', { name: `Send to ${a.name}` }).click();
  await a.page.getByRole('list', { name: 'Messages' }).getByRole('img', { name: caption, exact: true }).waitFor({ timeout: T.sync });

  // Bytes as stored on the phones (the processed upload and the rendered meme are only ever on-device).
  for (const id of (await idbAll(b.page, 'memes')).map((m: any) => m.id)) {
    const bytes: number[] = await b.page.evaluate(
      (memeId: string) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('memes');
          open.onsuccess = () => {
            const req = open.result.transaction('memeData').objectStore('memeData').get(memeId);
            req.onsuccess = () => {
              resolve([...new Uint8Array(req.result.data)]);
              open.result.close();
            };
            req.onerror = () => reject(req.error);
          };
        }),
      id,
    );
    memeBytes.push(Buffer.from(bytes));
  }
  pairingSecrets = [(await idbAll(a.page, 'profile'))[0].secret, (await idbAll(b.page, 'profile'))[0].secret];
  // One more round trip after reload, so reconnect signaling is covered as well.
  await b.page.reload();
  const t3 = token('after-reconnect-');
  secrets.push(t3);
  await b.page.locator('.chat-top .topbar-sub', { hasText: /^online$/ }).waitFor({ timeout: T.sync });
  await sendText(b.page, t3);
  await waitBubble(a.page, t3);
}, 120_000);

afterAll(async () => {
  guard?.restore();
  await env?.close();
});

const text = (p: string | Buffer) => (typeof p === 'string' ? p : p.toString('latin1'));

describe('privacy', () => {
  it('no message text, display name or pairing secret appears in any HTTP request or relay frame', () => {
    expect(secrets.length).toBeGreaterThanOrEqual(5);
    expect(pairingSecrets.every(Boolean)).toBe(true);
    const needles = [...secrets, ...pairingSecrets, ...secrets.map(encodeURIComponent)];
    const haystacks = [
      ...env.log.requests.map((r) => `${r.method} ${r.url}\n${r.postData ? text(r.postData) : ''}`),
      ...env.log.frames.map((f) => text(f.payload)),
      ...relayUpstreamLog,
    ];
    expect(env.log.requests.length).toBeGreaterThan(10);
    expect(env.log.frames.length).toBeGreaterThan(5);
    for (const h of haystacks) for (const n of needles) expect(h.includes(n), `leak of "${n}" in: ${h.slice(0, 200)}`).toBe(false);
  });

  it('no meme bytes appear in any HTTP request body or relay frame', () => {
    expect(memeBytes.length).toBeGreaterThanOrEqual(6);
    const sigs = memeBytes.flatMap((b) => leakSignatures(b));
    for (const r of env.log.requests) {
      expect(['GET', 'HEAD', 'OPTIONS'], `${r.method} ${r.url}`).toContain(r.method);
      expect(r.postData?.length ?? 0, r.url).toBe(0);
    }
    for (const f of env.log.frames) {
      expect(typeof f.payload, 'relay frames are text').toBe('string');
      expect((f.payload as string).length).toBeLessThan(64 * 1024);
      for (const s of sigs) expect((f.payload as string).includes(s)).toBe(false);
    }
  });

  it('only the app/relay origin and the mocked meme hosts are contacted', () => {
    expect(env.log.unexpected).toEqual([]);
    const hosts = new Set<string>();
    for (const r of env.log.requests) {
      const u = new URL(r.url);
      if (u.protocol === 'data:' || u.protocol === 'blob:') continue;
      hosts.add(u.origin === env.origin ? 'relay' : u.hostname);
    }
    for (const h of hosts) expect(['relay', ...MEME_HOSTS]).toContain(h);
    expect(hosts.has('relay')).toBe(true);
    // Both routes were really exercised.
    expect(a.directHits.some((u) => u.includes('reddit.com'))).toBe(true);
    expect(env.log.requests.some((r) => r.url.startsWith(`${env.origin}/proxy/reddit/`))).toBe(true);
    expect(env.log.requests.some((r) => r.url.startsWith(`${env.origin}/proxy/image?url=`))).toBe(true);
    // WebSockets only ever go to the relay's /ws.
    const wsUrls = new Set(env.log.frames.map((f) => f.url));
    expect([...wsUrls]).toEqual([env.url.replace(/^http/, 'ws') + '/ws']);
  });

  it('every relay frame has the expected shape, and every signal is a signed { payload, mac } envelope', () => {
    const allowedSent = new Set(['join', 'signal', 'ping']);
    const allowedReceived = new Set(['joined', 'peer-joined', 'peer-left', 'signal', 'pong', 'error']);
    let signals = 0;
    const kinds = new Set<string>();
    for (const f of env.log.frames) {
      const msg = JSON.parse(f.payload as string);
      expect((f.dir === 'sent' ? allowedSent : allowedReceived).has(msg.type), JSON.stringify(msg).slice(0, 120)).toBe(true);
      if (msg.type === 'join') {
        expect(Object.keys(msg).sort()).toEqual(['deviceId', 'room', 'type']);
        expect(msg.room).toMatch(/^[0-9a-f]{32}$/);
      }
      if (msg.type === 'signal') {
        signals++;
        expect(Object.keys(msg).sort()).toEqual(['envelope', 'type']);
        expect(Object.keys(msg.envelope).sort()).toEqual(['mac', 'payload']);
        expect(typeof msg.envelope.payload).toBe('string');
        expect(msg.envelope.mac).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url HMAC-SHA256
        const p = JSON.parse(msg.envelope.payload);
        expect(Object.keys(p).sort()).toEqual(['data', 'from', 'nonce', 'ts', 'v']);
        expect(['offer', 'answer', 'ice']).toContain(p.data.kind);
        kinds.add(p.data.kind);
      }
    }
    expect(signals).toBeGreaterThan(2);
    expect([...kinds].sort()).toEqual(expect.arrayContaining(['answer', 'offer']));
  });

  it('the relay process created no files', () => {
    // Positive control: the wrappers do see the relay (it streams the app's static files).
    expect(guard.reads.filter(fromRelay).length).toBeGreaterThan(0);
    expect(guard.relayCalls().map((c) => `${c.fn}(${c.target})`)).toEqual([]);
    expect(guard.repoChanges).toEqual([]);
  });
});
