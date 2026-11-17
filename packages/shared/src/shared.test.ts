import { describe, expect, it } from 'vitest';
import {
  decodePairingCode,
  deriveKeys,
  encodePairingCode,
  generatePairingSecret,
  openSignal,
  parseClientToRelay,
  parseControlFrame,
  sha256Hex,
  signSignal,
  toWsUrl,
  toHttpUrl,
  ulid,
  ulidTime,
  ULID_PATTERN,
  Emitter,
} from './index';

describe('pairing code', () => {
  it('round-trips and is lenient', () => {
    const s = generatePairingSecret();
    const code = encodePairingCode(s);
    expect(code).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(decodePairingCode(code)).toEqual(s);
    expect(decodePairingCode(code.toLowerCase().replace(/-/g, ' '))).toEqual(s);
  });
  it('rejects garbage', () => {
    expect(decodePairingCode('nope')).toBeNull();
    expect(decodePairingCode('U'.repeat(32))).toBeNull();
  });
});

describe('keys + signing', () => {
  it('derives the same room on both sides and different rooms for different secrets', async () => {
    const s = generatePairingSecret();
    const a = await deriveKeys(s);
    const b = await deriveKeys(decodePairingCode(encodePairingCode(s))!);
    expect(a.roomId).toBe(b.roomId);
    expect(a.roomId).toMatch(/^[0-9a-f]{32}$/);
    expect((await deriveKeys(generatePairingSecret())).roomId).not.toBe(a.roomId);
  });

  it('verifies, rejects tampering, wrong key, replay and skew', async () => {
    const s = generatePairingSecret();
    const k = await deriveKeys(s);
    const env = await signSignal(k, 'device-aaaa', { kind: 'offer', sdp: 'v=0' });
    const seen = new Set<string>();
    const p = await openSignal(k, env, { seenNonces: seen });
    expect(p?.data).toEqual({ kind: 'offer', sdp: 'v=0' });
    expect(await openSignal(k, env, { seenNonces: seen })).toBeNull(); // replay
    expect(await openSignal(k, { ...env, payload: env.payload.replace('v=0', 'v=1') })).toBeNull();
    expect(await openSignal(await deriveKeys(generatePairingSecret()), env)).toBeNull();
    expect(await openSignal(k, env, { now: Date.now() + 10 * 60_000 })).toBeNull();
  });
});

describe('ulid', () => {
  it('is monotonic and sortable', () => {
    const ids = Array.from({ length: 1000 }, () => ulid());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(ULID_PATTERN));
    expect(Math.abs(ulidTime(ulid()) - Date.now())).toBeLessThan(1000);
  });
});

describe('validation', () => {
  it('parses valid frames and rejects bad ones', () => {
    const memeId = 'a'.repeat(64);
    const msg = { id: ulid(), authorId: 'dev1', kind: 'meme', memeId, createdAt: Date.now() };
    expect(parseControlFrame(JSON.stringify({ type: 'msg', message: msg }))).not.toBeNull();
    expect(parseControlFrame({ type: 'msg', message: { ...msg, memeId: 'x' } })).toBeNull();
    expect(parseControlFrame('{"type":"typing","active":"yes"}')).toBeNull();
    expect(parseControlFrame('not json')).toBeNull();
    expect(parseClientToRelay(JSON.stringify({ type: 'join', room: '0'.repeat(32), deviceId: 'abcdefgh' }))).toEqual({
      type: 'join',
      room: '0'.repeat(32),
      deviceId: 'abcdefgh',
    });
    expect(parseClientToRelay(JSON.stringify({ type: 'join', room: 'short', deviceId: 'abcdefgh' }))).toBeNull();
  });
});

describe('util', () => {
  it('builds relay urls', () => {
    expect(toWsUrl('https://relay.example.com/')).toBe('wss://relay.example.com/ws');
    expect(toWsUrl('localhost:8787')).toBe('ws://localhost:8787/ws');
    expect(toHttpUrl('wss://r.example.com', 'proxy/x')).toBe('https://r.example.com/proxy/x');
  });
  it('sha256 + emitter', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const e = new Emitter<{ x: number }>();
    const got: number[] = [];
    const off = e.on('x', (n) => got.push(n));
    e.emit('x', 1);
    off();
    e.emit('x', 2);
    expect(got).toEqual([1]);
  });
});
