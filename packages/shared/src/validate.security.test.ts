import { describe, expect, it } from 'vitest';
import {
  MAX_CONTROL_FRAME_CHARS,
  deriveKeys,
  generatePairingSecret,
  isMemeMeta,
  isMemeMime,
  openSignal,
  parseControlFrame,
  signSignal,
  ulid,
} from './index';

/**
 * Security review (A7): the shared validators are the first thing every byte from the
 * relay or the partner passes through. These tests pin the properties the rest of the
 * app relies on.
 */

const MEME_ID = 'a'.repeat(64);
const meta = (over: Record<string, unknown> = {}) => ({
  id: MEME_ID,
  mime: 'image/png',
  width: 10,
  height: 10,
  size: 100,
  source: 'upload',
  ...over,
});

describe('signed signaling envelopes (malicious relay)', () => {
  const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n';

  it('rejects an envelope whose SDP (DTLS fingerprint) was swapped by the relay', async () => {
    const keys = await deriveKeys(generatePairingSecret());
    const env = await signSignal(keys, 'device-aaaa', { kind: 'offer', sdp });
    const forged = { ...env, payload: env.payload.replace('AA:BB:CC', 'EE:VI:L0') };
    expect(await openSignal(keys, forged)).toBeNull();
  });

  it('rejects an envelope signed with a different pairing secret (relay-made offer)', async () => {
    const mine = await deriveKeys(generatePairingSecret());
    const relays = await deriveKeys(generatePairingSecret());
    const env = await signSignal(relays, 'device-aaaa', { kind: 'offer', sdp });
    expect(await openSignal(mine, env)).toBeNull();
  });

  it('rejects replays (same nonce) and stale envelopes', async () => {
    const keys = await deriveKeys(generatePairingSecret());
    const env = await signSignal(keys, 'device-aaaa', { kind: 'offer', sdp });
    const seen = new Set<string>();
    expect(await openSignal(keys, env, { seenNonces: seen })).not.toBeNull();
    expect(await openSignal(keys, env, { seenNonces: seen })).toBeNull();
    expect(await openSignal(keys, env, { now: Date.now() + 6 * 60_000 })).toBeNull();
  });

  it('survives malformed envelopes without throwing', async () => {
    const keys = await deriveKeys(generatePairingSecret());
    for (const env of [null, {}, { payload: 1, mac: 'x' }, { payload: '{}', mac: '!!!' }, { payload: 'x', mac: '' }]) {
      expect(await openSignal(keys, env as never)).toBeNull();
    }
  });
});

describe('control frames (malicious peer)', () => {
  it('only accepts raster image types for memes (no SVG / HTML)', () => {
    expect(isMemeMime('image/webp')).toBe(true);
    for (const m of ['image/svg+xml', 'image/svg', 'text/html', 'image/png; x', 'IMAGE/PNG', '', undefined]) {
      expect(isMemeMime(m)).toBe(false);
    }
    expect(isMemeMeta(meta())).toBe(true);
    expect(isMemeMeta(meta({ mime: 'image/svg+xml' }))).toBe(false);
    const msg = { id: ulid(), authorId: 'device-bbbb', kind: 'meme', memeId: MEME_ID, createdAt: Date.now() };
    expect(parseControlFrame(JSON.stringify({ type: 'msg', message: msg, meme: meta({ mime: 'image/svg+xml' }) }))).toBeNull();
  });

  it('rejects oversized frames before parsing them', () => {
    const big = JSON.stringify({ type: 'profile', displayName: 'x'.repeat(MAX_CONTROL_FRAME_CHARS) });
    expect(parseControlFrame(big)).toBeNull();
  });

  it('caps free-form strings and validates ids', () => {
    const msg = (over: Record<string, unknown>) =>
      JSON.stringify({ type: 'msg', message: { id: ulid(), authorId: 'device-bbbb', kind: 'text', text: 'hi', createdAt: 1, ...over } });
    expect(parseControlFrame(msg({}))).not.toBeNull();
    expect(parseControlFrame(msg({ authorId: 'x'.repeat(65) }))).toBeNull();
    expect(parseControlFrame(msg({ replyTo: 'not-a-ulid' }))).toBeNull();
    expect(parseControlFrame(msg({ kind: 'reaction', replyTo: ulid(), emoji: '😂'.repeat(17) }))).toBeNull();
    expect(parseControlFrame(msg({ text: 'x'.repeat(10_001) }))).toBeNull();
    const m = { id: ulid(), authorId: 'device-bbbb', kind: 'meme', memeId: MEME_ID, createdAt: 1 };
    expect(parseControlFrame(JSON.stringify({ type: 'msg', message: m, meme: meta({ title: 'x'.repeat(5000) }) }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ type: 'read', upToId: 'zzzz' }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ type: 'ack', ids: ['nope'] }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ type: 'ack', ids: Array.from({ length: 1001 }, () => ulid()) }))).toBeNull();
    expect(
      parseControlFrame(JSON.stringify({ type: 'hello', v: 1, deviceId: 'd'.repeat(65), displayName: 'x', lastReceivedId: null, lastReadId: null })),
    ).toBeNull();
    expect(
      parseControlFrame(JSON.stringify({ type: 'hello', v: 1, deviceId: 'device-b', displayName: 'x', lastReceivedId: 'x', lastReadId: null })),
    ).toBeNull();
  });

  it('does not let "__proto__" keys pollute Object.prototype', () => {
    const raw = '{"type":"typing","active":true,"__proto__":{"polluted":true}}';
    const f = parseControlFrame(raw);
    expect(f).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
