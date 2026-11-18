import { describe, expect, it } from 'vitest';
import type { ControlFrame } from '@memes/shared';
import { createLoopbackPair } from './loopback';

describe('loopback transport', () => {
  it('connects, delivers frames and blobs, and disconnects', async () => {
    const { a, b, link, unlink } = createLoopbackPair();
    const frames: ControlFrame[] = [];
    const blobs: string[] = [];
    b.on('frame', (f) => frames.push(f));
    b.on('blob', (x) => blobs.push(x.memeId));
    a.start();
    b.start();
    expect(a.state).toBe('waiting');
    expect(a.send({ type: 'typing', active: true })).toBe(false);
    link();
    expect(b.state).toBe('connected');
    expect(a.send({ type: 'typing', active: true })).toBe(true);
    await a.sendBlob('f'.repeat(64), 'image/png', new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 0));
    expect(frames).toEqual([{ type: 'typing', active: true }]);
    expect(blobs).toEqual(['f'.repeat(64)]);
    unlink();
    expect(a.state).toBe('waiting');
  });
});
