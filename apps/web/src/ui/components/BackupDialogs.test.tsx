// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setBackupKdfTuning } from '../../db/backupCrypto';
import { App } from '../App';
import { createMockServices, type MockAppServices } from '../mock/createMockServices';
import { ExportBackupDialog, ImportPasswordDialog, passwordStrength } from './BackupDialogs';

let restoreTuning: () => void;
beforeAll(() => {
  restoreTuning = setBackupKdfTuning({ iterations: 1000, minIterations: 1000 });
});
afterAll(() => restoreTuning());

const opened: MockAppServices[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((s) => s.dispose()));
});

const PW = 'tacos on tuesday 42';

async function openSettings() {
  const services = createMockServices({ scenario: 'paired', timeScale: 0.01, autoReply: false, partnerJoinMs: 1e9 });
  opened.push(services);
  await services.demo.ready;
  render(<App services={services} />);
  fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
  await screen.findByRole('heading', { name: 'Backup' });
  return services;
}

/** Capture what downloadBlob() hands to the browser. */
function captureDownloads() {
  const urls = new Map<string, Blob>();
  const blobs: Blob[] = [];
  const names: string[] = [];
  Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => {
      const url = `blob:test-${urls.size}`;
      urls.set(url, b);
      return url;
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
    blobs.push(urls.get(this.href)!);
  });
  return { blobs, names };
}

describe('passwordStrength', () => {
  it('rates by length first, variety second, and flags obvious passwords', () => {
    expect(passwordStrength('short').score).toBe(0);
    expect(passwordStrength('abcdefgh'.replace('abc', 'xyz')).score).toBe(1);
    expect(passwordStrength('Tr0ub4d!').score).toBe(2);
    expect(passwordStrength('tacos on tuesday').score).toBe(3);
    expect(passwordStrength('Password1234!!!!').score).toBe(1);
    expect(passwordStrength('aaaaaaaaaaaaaaaaaaaa').score).toBe(1);
  });
});

describe('ExportBackupDialog', () => {
  it('needs 8+ characters and a matching confirmation, warns about forgetting, and shows progress', async () => {
    let finish!: () => void;
    const onExport = vi.fn(() => new Promise<void>((r) => (finish = r)));
    render(<ExportBackupDialog onExport={onExport} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Export an encrypted backup' });
    expect(dialog.textContent).toContain("If you forget this password, the backup can't be opened. We can't recover it.");
    const pw = screen.getByLabelText('Backup password') as HTMLInputElement;
    const confirm = screen.getByLabelText('Confirm password') as HTMLInputElement;
    expect(document.activeElement).toBe(pw);
    expect(pw.type).toBe('password');

    fireEvent.change(pw, { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /Encrypt & download/ }));
    expect(screen.getByRole('alert').textContent).toMatch(/at least 8 characters/);
    expect(pw.getAttribute('aria-invalid')).toBe('true');
    expect(onExport).not.toHaveBeenCalled();

    fireEvent.change(pw, { target: { value: PW } });
    expect(screen.getByText(/Strength: Strong/)).toBeTruthy();
    fireEvent.change(confirm, { target: { value: PW + 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Encrypt & download/ }));
    expect(screen.getByRole('alert').textContent).toMatch(/don't match/);
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(screen.getByLabelText('Show passwords'));
    expect(pw.type).toBe('text');

    fireEvent.change(confirm, { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: /Encrypt & download/ }));
    expect(onExport).toHaveBeenCalledWith(PW);
    expect(screen.getByRole('progressbar', { name: 'Encrypting your backup' })).toBeTruthy();
    expect(pw.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
  });

  it('shows a failure inside the dialog and lets the user try again', async () => {
    const onExport = vi.fn().mockRejectedValueOnce(new Error('backup-too-large')).mockResolvedValue(undefined);
    render(<ExportBackupDialog onExport={onExport} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Backup password'), { target: { value: PW } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: /Encrypt & download/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/too big/);
    fireEvent.click(screen.getByRole('button', { name: /Encrypt & download/ }));
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(2));
  });
});

describe('ImportPasswordDialog', () => {
  it('shows "wrong password" inline, refocuses the field, and retries without re-picking the file', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('wrong-password')).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ImportPasswordDialog fileName="meme-pals-backup-2026-11-18.json" onSubmit={onSubmit} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Enter the backup password' });
    expect(dialog.textContent).toContain('meme-pals-backup-2026-11-18.json');
    const pw = screen.getByLabelText('Backup password') as HTMLInputElement;
    expect(document.activeElement).toBe(pw);

    fireEvent.click(screen.getByRole('button', { name: /Unlock & import/ }));
    expect(screen.getByRole('alert').textContent).toMatch(/Enter the backup password/);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(pw, { target: { value: 'nope nope' } });
    fireEvent.click(screen.getByRole('button', { name: /Unlock & import/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong password. Check it and try again.');
    await waitFor(() => expect(document.activeElement).toBe(pw));
    expect(pw.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.change(pw, { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: /Unlock & import/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(PW));
    // While it is decrypting, the dialog can't be dismissed.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Settings → Backup (mock services)', () => {
  it('exports an encrypted file and imports it back through the password prompt', async () => {
    const downloads = captureDownloads();
    const src = await openSettings();
    const myText = src.chat.messages.get().find((m) => m.text)?.text;
    expect(myText).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    fireEvent.change(screen.getByLabelText('Backup password'), { target: { value: PW } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: /Encrypt & download/ }));
    await screen.findByText('Encrypted backup downloaded');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(downloads.names).toEqual([expect.stringMatching(/^meme-pals-backup-\d{4}-\d{2}-\d{2}\.json$/)]);
    const text = await downloads.blobs[0]!.text();
    expect(JSON.parse(text).format).toBe('meme-pals-backup-encrypted');
    expect(text).not.toContain(myText!);
    cleanup();

    // A different (fresh) phone imports it.
    await openSettings();
    const file = new File([text], 'meme-pals-backup-2026-11-18.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('backup-file'), { target: { files: [file] } });
    const dialog = await screen.findByRole('dialog', { name: 'Enter the backup password' });
    fireEvent.change(within(dialog).getByLabelText('Backup password'), { target: { value: 'wrong password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Unlock & import/ }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Wrong password/);

    fireEvent.change(within(dialog).getByLabelText('Backup password'), { target: { value: PW } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Unlock & import/ }));
    await screen.findByText(/^Imported \d+ messages and \d+ memes?$/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/^Last import: \d+ messages and \d+ memes? from meme-pals-backup-2026-11-18\.json\.$/)).toBeTruthy();
  });

  it('imports a legacy plain backup without asking for a password', async () => {
    const src = createMockServices({ scenario: 'paired', timeScale: 0 });
    opened.push(src);
    await src.demo.ready;
    const plain = await (await src.backup.exportBackup()).text();
    await openSettings();
    fireEvent.change(screen.getByTestId('backup-file'), { target: { files: [new File([plain], 'old.json')] } });
    await screen.findByText(/^Imported \d+ messages and \d+ memes?$/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports a file that is not a backup', async () => {
    await openSettings();
    fireEvent.change(screen.getByTestId('backup-file'), { target: { files: [new File(['hello'], 'notes.txt')] } });
    await screen.findByText("That file isn't a Meme Pals backup.");
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
