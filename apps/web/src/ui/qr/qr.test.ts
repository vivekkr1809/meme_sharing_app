import { encodePairingCode, generatePairingSecret } from '@memes/shared';
import { describe, expect, it } from 'vitest';
import { cameraMessage, cameraPrecheck, classifyCameraError } from './camera';
import { codeCandidates, extractCode, parsePairingQr, pickPairingCode } from './code';
import { decodeStill, downscale, fitWithin, jsqrDecode, type Rgba } from './decode';
import { cameraRegion, centerCrop, createQrDetector, nativeQrSupport } from './detector';
import { QUIET_ZONE, qrMatrix, rasterize } from './matrix';
import { qrSvg } from './render';

const newCode = () => encodePairingCode(generatePairingSecret());

/** Deterministic PRNG so noisy variants are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Paste `img` into a w×h canvas filled with `bg`, at (x, y). */
function place(img: Rgba, w: number, h: number, x: number, y: number, bg = 255): Rgba {
  const data = new Uint8ClampedArray(w * h * 4).fill(bg);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (let yy = 0; yy < img.height; yy++) {
    data.set(img.data.subarray(yy * img.width * 4, (yy + 1) * img.width * 4), ((y + yy) * w + x) * 4);
  }
  return { data, width: w, height: h };
}

function addNoise(img: Rgba, amount: number, saltPepper: number, seed = 1): Rgba {
  const r = rng(seed);
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (r() < saltPepper) {
      const v = r() < 0.5 ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
      continue;
    }
    const n = (r() - 0.5) * 2 * amount;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  return { data, width: img.width, height: img.height };
}

/** Light 3×3 blur, like a slightly out-of-focus camera. */
function blur(img: Rgba): Rgba {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += img.data[(yy * w + xx) * 4]!;
          n++;
        }
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = s / n;
      data[o + 3] = 255;
    }
  return { data, width: w, height: h };
}

describe('pairing code extraction', () => {
  const code = newCode();

  it('extracts the code from text with junk around it', () => {
    expect(extractCode(code)).toBe(code);
    expect(extractCode(`  hey! my code: ${code} 🙂 see you`)).toBe(code);
    expect(extractCode(`code ${code}`)).toBe(code); // a 4-letter word in front isn't swallowed
    expect(extractCode(`Meme Pals pairing code\n${code.slice(0, 20)}\n${code.slice(20)}`)).toBe(code); // the saved PNG caption, as OCR'd/pasted
    expect(extractCode(code.toLowerCase())).toBe(code);
    expect(extractCode(code.replace(/-/g, ' '))).toBe(code);
    expect(extractCode(`(${code.replace(/-/g, '')})`)).toBe(code);
    expect(extractCode(`https://example.com/pair#${code}`)).toBe(code);
  });

  it('canonicalises look-alike letters', () => {
    const typo = code.replace(/0/g, 'O').replace(/1/g, 'l');
    expect(extractCode(typo)).toBe(code);
  });

  it('leaves non-codes alone so the service can reject them', () => {
    expect(extractCode('  NOT-A-CODE ')).toBe('NOT-A-CODE');
    expect(codeCandidates('nothing here')).toEqual([]);
  });

  it('accepts only Meme Pals codes from QR content', () => {
    expect(parsePairingQr(code)).toBe(code);
    expect(parsePairingQr(`\n${code}\n`)).toBe(code);
    expect(parsePairingQr(code.replace(/-/g, ''))).toBe(code);
    expect(parsePairingQr('https://example.com/some/page?x=1')).toBeNull();
    expect(parsePairingQr('WIFI:S:home;T:WPA;P:hunter2;;')).toBeNull();
    expect(parsePairingQr('')).toBeNull();
    // A link with a long id in it is not a code, even if the id happens to be base32.
    expect(parsePairingQr(`https://example.com/${code.replace(/-/g, '')}`)).toBeNull();
    // 'U' is not Crockford base32.
    expect(parsePairingQr(code.slice(0, -1) + 'U')).toBeNull();
  });

  it('picks the Meme Pals code among several values and reports foreign ones', () => {
    expect(pickPairingCode(['https://x.test', code])).toEqual({ code, foreign: false });
    expect(pickPairingCode(['https://x.test'])).toEqual({ code: null, foreign: true });
    expect(pickPairingCode([])).toEqual({ code: null, foreign: false });
  });
});

describe('QR generation', () => {
  it('uses a small symbol with the full quiet zone, black on white', () => {
    const code = newCode();
    const m = qrMatrix(code);
    expect(m.size).toBeLessThanOrEqual(33); // version ≤ 4: big modules on screen
    const svg = qrSvg(m);
    expect(svg).toContain(`viewBox="0 0 ${m.size + 2 * QUIET_ZONE} ${m.size + 2 * QUIET_ZONE}"`);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
    expect(svg).toContain('crispEdges');
  });
});

describe('jsQR pipeline', () => {
  const code = newCode();
  const m = qrMatrix(code);

  it('decodes clean codes at many scales, including fractional ones', () => {
    for (const scale of [2, 3, 4.5, 8, 13.7]) {
      expect(decodeStill(rasterize(m, { scale })), `scale ${scale}`).toBe(code);
    }
  });

  it('decodes inverted (light on dark) codes', () => {
    expect(jsqrDecode(rasterize(m, { scale: 6, invert: true }))).toBe(code);
  });

  it('decodes noisy, blurred and low-contrast codes', () => {
    const base = rasterize(m, { scale: 7 });
    expect(decodeStill(addNoise(base, 70, 0.02, 7))).toBe(code);
    expect(decodeStill(blur(blur(base)))).toBe(code);
    expect(decodeStill(rasterize(m, { scale: 6, darkLevel: 90, lightLevel: 190 }))).toBe(code);
    expect(decodeStill(addNoise(rasterize(m, { scale: 5, invert: true }), 40, 0.01, 3))).toBe(code);
  });

  it('finds a small code in a big screenshot (downscaled pass, then full resolution)', () => {
    // A phone screenshot: 1170×2532 with the QR as a small part of it.
    const shot = place(rasterize(m, { scale: 4 }), 1170, 2532, 400, 1700, 238);
    expect(decodeStill(shot)).toBe(code);
    // And one so small that only the full-resolution pass can read it.
    const tiny = place(rasterize(m, { scale: 2 }), 2400, 2400, 1900, 100, 255);
    expect(jsqrDecode(downscale(tiny, 1024))).toBeNull();
    expect(decodeStill(tiny)).toBe(code);
  });

  it('reads other QR codes, which the app then rejects', () => {
    const url = rasterize(qrMatrix('https://example.com/not-a-pairing-code'), { scale: 5 });
    const value = decodeStill(url);
    expect(value).toBe('https://example.com/not-a-pairing-code');
    expect(parsePairingQr(value!)).toBeNull();
    expect(pickPairingCode([value!]).foreign).toBe(true);
  });

  it('returns null when there is no code', () => {
    const blank = place({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, 300, 200, 0, 0, 200);
    expect(decodeStill(addNoise(blank, 80, 0.05))).toBeNull();
  });

  it('downscales with a box filter and never upscales', () => {
    const img = rasterize(m, { scale: 10 });
    const small = downscale(img, 100);
    expect(Math.max(small.width, small.height)).toBe(100);
    expect(downscale(small, 1000)).toBe(small);
    expect(fitWithin(1920, 1080, 640)).toEqual({ width: 640, height: 360 });
    expect(fitWithin(300, 200, Infinity)).toEqual({ width: 300, height: 200 });
  });
});

describe('detector selection', () => {
  it('uses the native BarcodeDetector when it reads QR codes', async () => {
    const calls: unknown[] = [];
    class FakeBD {
      static getSupportedFormats = async () => ['ean_13', 'qr_code'];
      constructor(opts: { formats: string[] }) {
        calls.push(opts);
      }
      async detect(source: unknown) {
        calls.push(source);
        return [{ rawValue: 'https://x.test' }, { rawValue: 'CODE' }];
      }
    }
    const d = await createQrDetector({ BarcodeDetector: FakeBD });
    expect(d.kind).toBe('native');
    const source = {} as CanvasImageSource;
    // Whole frame: the source goes straight to the native detector (no canvas needed).
    expect(await d.detect(source, 640, 480)).toEqual(['https://x.test', 'CODE']);
    expect(calls).toEqual([{ formats: ['qr_code'] }, source]);
  });

  it('falls back to jsQR when BarcodeDetector is missing or lacks QR support', async () => {
    expect(await nativeQrSupport({})).toBeNull();
    class NoQr {
      static getSupportedFormats = async () => ['ean_13'];
    }
    expect(await nativeQrSupport({ BarcodeDetector: NoQr })).toBeNull();
    class Broken {
      static getSupportedFormats = async () => {
        throw new Error('nope');
      };
    }
    expect(await nativeQrSupport({ BarcodeDetector: Broken })).toBeNull();
    expect((await createQrDetector({})).kind).toBe('jsqr');
  });

  it('alternates whole frame and centre crop for jsQR, whole frame for native', () => {
    expect(cameraRegion('native', 1280, 720, 1)).toEqual({});
    expect(cameraRegion('jsqr', 1280, 720, 0)).toEqual({ maxDim: 640 });
    expect(cameraRegion('jsqr', 1280, 720, 1)).toEqual({ crop: centerCrop(1280, 720), maxDim: 720 });
    expect(centerCrop(1280, 720)).toEqual({ x: 424, y: 144, w: 432, h: 432 });
  });
});

describe('camera problems', () => {
  const err = (name: string) => Object.assign(new Error(name), { name });

  it('maps getUserMedia errors to clear messages', () => {
    expect(classifyCameraError(err('NotAllowedError'))).toBe('denied');
    expect(classifyCameraError(err('SecurityError'))).toBe('denied');
    expect(classifyCameraError(err('NotFoundError'))).toBe('no-camera');
    expect(classifyCameraError(err('OverconstrainedError'))).toBe('no-camera');
    expect(classifyCameraError(err('NotReadableError'))).toBe('in-use');
    expect(classifyCameraError(err('TrackStartError'))).toBe('in-use');
    expect(classifyCameraError(err('Weird'))).toBe('other');
    expect(classifyCameraError(undefined)).toBe('other');
    expect(cameraMessage('denied')).toMatch(/blocked/);
    expect(cameraMessage('no-camera')).toMatch(/No camera found/);
    expect(cameraMessage('in-use')).toMatch(/another app/);
    expect(cameraMessage('insecure')).toMatch(/https/);
  });

  it('detects an insecure context (http on a phone) before asking for the camera', () => {
    const media = { getUserMedia: () => {} } as unknown as MediaDevices;
    expect(cameraPrecheck({ isSecureContext: false, navigator: { mediaDevices: media } as Navigator })).toBe('insecure');
    expect(cameraPrecheck({ isSecureContext: true, navigator: {} as Navigator })).toBe('unsupported');
    expect(cameraPrecheck({ isSecureContext: true, navigator: { mediaDevices: media } as Navigator })).toBeNull();
  });
});
