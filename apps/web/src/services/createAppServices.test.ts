import { describe, expect, it, vi } from 'vitest';
import { deriveKeys, generatePairingSecret } from '@memes/shared';
import type { TransportOptions } from '../contracts';
import { createLoopbackPair } from '../testing/loopback';
import { FALLBACK_ICE_SERVERS, fetchIceServers, withRelayIceConfig } from './createAppServices';

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('fetchIceServers', () => {
  it('uses the relay config and falls back on errors or bad shapes', async () => {
    const ice = [{ urls: 'turn:t.example.com', username: 'u', credential: 'c' }];
    expect(await fetchIceServers('https://r.example.com', (async () => ok({ iceServers: ice })) as typeof fetch)).toEqual(ice);
    expect(await fetchIceServers('', (async () => ok({ iceServers: [{ urls: 5 }] })) as typeof fetch)).toEqual(
      FALLBACK_ICE_SERVERS,
    );
    expect(await fetchIceServers('', (async () => { throw new Error('offline'); }) as typeof fetch)).toEqual(
      FALLBACK_ICE_SERVERS,
    );
  });
});

describe('withRelayIceConfig', () => {
  it('fetches ICE config from the given relay, then delegates to the real transport', async () => {
    const { a, b, link } = createLoopbackPair();
    const ice = [{ urls: 'stun:s.example.com' }];
    const fetchImpl = vi.fn(async () => ok({ iceServers: ice })) as unknown as typeof fetch;
    let seen: TransportOptions | undefined;
    const create = withRelayIceConfig((o) => ((seen = o), a), fetchImpl);
    const keys = await deriveKeys(generatePairingSecret());
    const t = create({ relayUrl: 'https://relay.example.com', keys, deviceId: 'device-aaaa' });
    const states: string[] = [];
    t.on('state', (s) => states.push(s));
    t.start();
    b.start();
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(fetchImpl).toHaveBeenCalledWith('https://relay.example.com/config', expect.anything());
    expect(seen!.iceServers).toEqual(ice);
    link();
    expect(t.state).toBe('connected');
    expect(t.send({ type: 'typing', active: true })).toBe(true);
    t.stop();
    expect(states).toEqual(['connecting', 'waiting', 'connected', 'idle']);
  });
});
