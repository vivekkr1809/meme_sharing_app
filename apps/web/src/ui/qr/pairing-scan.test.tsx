// @vitest-environment jsdom
import { encodePairingCode, generatePairingSecret } from '@memes/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { createMockServices, type MockAppServices } from '../mock/createMockServices';

/** The photo decoder is mocked (jsdom has no canvas); the real pipeline is covered in qr.test.ts and E2E. */
vi.mock('./photo', () => ({ scanImageFile: vi.fn() }));
import { scanImageFile } from './photo';

const scanMock = vi.mocked(scanImageFile);
let services: MockAppServices | null = null;

async function openJoin() {
  services = createMockServices({ scenario: 'onboarded', timeScale: 0.01, autoReply: false, partnerJoinMs: 1e9 });
  const accept = vi.spyOn(services.pairing, 'acceptPairing');
  render(<App services={services} />);
  fireEvent.click(await screen.findByRole('button', { name: /Join my partner/ }));
  return { services, accept };
}

function choosePhoto() {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
  expect(input.accept).toBe('image/*');
  expect(input.hasAttribute('capture')).toBe(false); // the gallery (screenshots) must be allowed
  const file = new File([new Uint8Array([1, 2, 3])], 'code.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

// ─── camera fakes ──────────────────────────────────────────────────────────

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
}

function fakeStream() {
  const track: FakeTrack = { stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

function setMediaDevices(getUserMedia: ((c: MediaStreamConstraints) => Promise<MediaStream>) | undefined) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: getUserMedia ? { getUserMedia: vi.fn(getUserMedia) } : undefined,
  });
  return navigator.mediaDevices?.getUserMedia as ReturnType<typeof vi.fn> | undefined;
}

const domError = (name: string) => new DOMException('camera says no', name);

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
}

/** Make <video> look like it is playing a 640×480 stream, so the frame loop runs. */
function fakePlayingVideo() {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(480);
}

/** A native BarcodeDetector that "sees" whatever `values()` returns. */
function fakeBarcodeDetector(values: () => string[]) {
  class FakeBarcodeDetector {
    static getSupportedFormats = async () => ['qr_code'];
    async detect() {
      return values().map((rawValue) => ({ rawValue }));
    }
  }
  vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
}

beforeEach(() => {
  history.replaceState(null, '', '/');
  fakePlayingVideo();
});

afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = null;
  scanMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(window, 'isSecureContext');
});

describe('join from a photo of the code', () => {
  it('pairs with the code in the picture', async () => {
    const { accept } = await openJoin();
    const code = encodePairingCode(generatePairingSecret());
    scanMock.mockResolvedValue(['https://example.com/menu', code.toLowerCase()]);
    const file = choosePhoto();
    await screen.findByRole('heading', { name: "You're paired!" });
    expect(scanMock).toHaveBeenCalledWith(file);
    expect(accept).toHaveBeenCalledWith(code);
  });

  it('says so when the picture has some other QR code', async () => {
    const { accept } = await openJoin();
    scanMock.mockResolvedValue(['https://example.com/menu']);
    choosePhoto();
    expect((await screen.findByRole('alert')).textContent).toMatch(/That QR code isn’t a Meme Pals code/);
    expect(accept).not.toHaveBeenCalled();
  });

  it('says so when there is no QR code, or the file is not an image', async () => {
    await openJoin();
    scanMock.mockResolvedValue([]);
    choosePhoto();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t find a QR code/);

    scanMock.mockRejectedValue(new Error('decode-failed'));
    choosePhoto();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/couldn’t be opened/));
    // The typed-code form is still there.
    expect(screen.getByLabelText('Pairing code')).toBeTruthy();
  });
});

describe('camera scanning', () => {
  it('explains a denied camera permission', async () => {
    await openJoin();
    const gum = setMediaDevices(() => Promise.reject(domError('NotAllowedError')));
    fireEvent.click(screen.getByRole('button', { name: /Scan QR code/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Camera access is blocked.*browser settings/);
    expect(gum).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ facingMode: { ideal: 'environment' } }) }));
    // Back to the buttons; the scanner is gone.
    expect(screen.getByRole('button', { name: /Scan QR code/ })).toBeTruthy();
    expect(screen.queryByLabelText('Camera preview')).toBeNull();
  });

  it('explains a missing camera', async () => {
    await openJoin();
    setMediaDevices(() => Promise.reject(domError('NotFoundError')));
    fireEvent.click(screen.getByRole('button', { name: /Scan QR code/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/No camera found/);
  });

  it('explains a camera that is busy in another app', async () => {
    await openJoin();
    setMediaDevices(() => Promise.reject(domError('NotReadableError')));
    fireEvent.click(screen.getByRole('button', { name: /Scan QR code/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/another app/);
  });

  it('explains an insecure (http) page without asking for the camera', async () => {
    await openJoin();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    const gum = setMediaDevices(() => Promise.reject(domError('NotAllowedError')));
    fireEvent.click(screen.getByRole('button', { name: /Scan QR code/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/secure \(https:\/\/\) connection/);
    expect(gum).not.toHaveBeenCalled();
  });

  it('releases the camera on cancel and while the tab is hidden', async () => {
    await openJoin();
    fakeBarcodeDetector(() => []);
    const streams: FakeTrack[] = [];
    const gum = setMediaDevices(async () => {
      const { stream, track } = fakeStream();
      streams.push(track);
      return stream;
    })!;
    fireEvent.click(screen.getByRole('button', { name: /Scan QR code/ }));
    await waitFor(() => expect(screen.queryByText(/Starting camera/)).toBeNull());
    expect(gum).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await waitFor(() => expect(streams[0]!.stop).toHaveBeenCalled());
    expect(screen.getByText('Camera paused')).toBeTruthy();

    setVisibility('visible');
    await waitFor(() => expect(gum).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Starting camera|Camera paused/)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Type instead/ }));
    expect(streams[1]!.stop).toHaveBeenCalled();
    expect(screen.queryByLabelText('Camera preview')).toBeNull();
  });

  it('ignores other QR codes, then joins automatically on a Meme Pals code', async () => {
    const { accept } = await openJoin();
    const code = encodePairingCode(generatePairingSecret());
    let seen: string[] = ['https://example.com/menu'];
    fakeBarcodeDetector(() => seen);
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    const { stream, track } = fakeStream();
    setMediaDevices(async () => stream);

    fireEvent.click(screen.getByRole('button', { name: /Scan QR code/ }));
    await screen.findByText('That QR code isn’t a Meme Pals code');
    expect(accept).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();

    seen = [code];
    await screen.findByRole('heading', { name: "You're paired!" });
    expect(accept).toHaveBeenCalledWith(code);
    expect(track.stop).toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalled();
    Reflect.deleteProperty(navigator, 'vibrate');
  });
});
