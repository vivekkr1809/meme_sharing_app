// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { createMockServices, type MockAppServices } from '../mock/createMockServices';
import { formatWait } from './Lock';

let services: MockAppServices | null = null;

async function setupPaired() {
  services = createMockServices({ scenario: 'paired', timeScale: 0.01, autoReply: false, partnerJoinMs: 1e9 });
  render(<App services={services} />);
  await services.demo.ready;
  await screen.findByRole('textbox', { name: 'Message' });
  return services;
}

const tab = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const lockSection = () => screen.getByRole('region', { name: 'Passcode lock' });

async function enableFromSettings(code: string) {
  fireEvent.click(tab('Settings'));
  fireEvent.click(within(lockSection()).getByRole('button', { name: /Turn on passcode lock/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Turn on passcode lock' });
  fireEvent.change(within(dialog).getByLabelText('New passcode'), { target: { value: code } });
  fireEvent.change(within(dialog).getByLabelText('Type it again'), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Turn on passcode lock' })).toBeNull());
}

async function unlockWith(code: string) {
  fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: /Unlock/ }));
}

beforeEach(() => {
  history.replaceState(null, '', '/');
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = null;
});

describe('Settings → Passcode lock', () => {
  it('checks the passcode twice, warns that forgetting means wiping, then turns on', async () => {
    const s = await setupPaired();
    fireEvent.click(tab('Settings'));
    expect(within(lockSection()).getByText('Off')).toBeTruthy();
    fireEvent.click(within(lockSection()).getByRole('button', { name: /Turn on passcode lock/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn on passcode lock' });
    expect(dialog.textContent).toMatch(/6 or more digits/);
    expect(dialog.textContent).toMatch(/only way back in is to wipe/);

    fireEvent.change(within(dialog).getByLabelText('New passcode'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/at least 4/);

    fireEvent.change(within(dialog).getByLabelText('New passcode'), { target: { value: '246810' } });
    fireEvent.change(within(dialog).getByLabelText('Type it again'), { target: { value: '246811' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/don't match/);
    expect(s.lock.state.get()).toBe('disabled');

    fireEvent.change(within(dialog).getByLabelText('Type it again'), { target: { value: '246810' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(s.lock.state.get()).toBe('unlocked'));
    await within(lockSection()).findByText(/^On\./);
  });

  it('auto-lock choice, change and turn off', async () => {
    const s = await setupPaired();
    await enableFromSettings('246810');
    const group = within(lockSection()).getByRole('radiogroup', { name: 'Auto-lock' });
    expect((within(group).getByLabelText('5 min') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(group).getByLabelText('Immediately'));
    await waitFor(() => expect(s.lock.autoLockMinutes.get()).toBe(0));

    fireEvent.click(within(lockSection()).getByRole('button', { name: 'Change passcode' }));
    let dialog = await screen.findByRole('dialog', { name: 'Change passcode' });
    fireEvent.change(within(dialog).getByLabelText('Current passcode'), { target: { value: '000000' } });
    fireEvent.change(within(dialog).getByLabelText('New passcode'), { target: { value: 'a long passphrase' } });
    fireEvent.change(within(dialog).getByLabelText('Type the new one again'), { target: { value: 'a long passphrase' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/isn't right/);
    fireEvent.change(within(dialog).getByLabelText('Current passcode'), { target: { value: '246810' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change passcode' })).toBeNull());

    fireEvent.click(within(lockSection()).getByRole('button', { name: 'Turn off' }));
    dialog = await screen.findByRole('dialog', { name: 'Turn off passcode lock' });
    fireEvent.change(within(dialog).getByLabelText('Current passcode'), { target: { value: 'a long passphrase' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(s.lock.state.get()).toBe('disabled'));
    expect(within(lockSection()).getByText('Off')).toBeTruthy();
  });
});

describe('lock screen', () => {
  it('Lock now shows the lock screen; a wrong passcode shows an error; the right one opens the chat', async () => {
    const s = await setupPaired();
    await enableFromSettings('246810');
    fireEvent.click(within(lockSection()).getByRole('button', { name: /Lock now/ }));
    await screen.findByRole('heading', { name: 'Meme Pals is locked' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(s.chat.connection.get()).toBe('idle');
    await expect(s.chat.sendText('nope')).rejects.toThrow('locked');

    // Digits-only passcode → number pad.
    const input = screen.getByLabelText('Passcode');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.getAttribute('type')).toBe('password');

    await unlockWith('111111');
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn't right/);
    await unlockWith('246810');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(s.lock.state.get()).toBe('unlocked');
  });

  it('uses a text keyboard for a passphrase', async () => {
    const s = await setupPaired();
    await enableFromSettings('pizza on fridays');
    await act(() => s.lock.lockNow());
    expect(screen.getByLabelText('Passcode').getAttribute('inputmode')).toBe('text');
  });

  it('after 5 wrong tries it counts down and disables the button', async () => {
    const s = await setupPaired();
    await enableFromSettings('246810');
    await act(() => s.lock.lockNow());
    for (let i = 0; i < 5; i++) {
      await unlockWith('000000');
      await waitFor(() => expect((screen.getByLabelText('Passcode') as HTMLInputElement).disabled).toBe(false));
    }
    const status = await screen.findByText(/Too many tries/);
    expect(status.textContent).toMatch(/0:(30|29)/);
    expect((screen.getByRole('button', { name: /Unlock/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(s.lock.retryAfterMs.get()).toBeGreaterThan(28_000);
  });

  it('"Forgot passcode?" wipes only after typing WIPE', async () => {
    const s = await setupPaired();
    await enableFromSettings('246810');
    await act(() => s.lock.lockNow());
    fireEvent.click(screen.getByRole('button', { name: /Forgot passcode/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Wipe this device?' });
    const go = within(dialog).getByRole('button', { name: /Wipe everything/ }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Type WIPE/), { target: { value: 'wip' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Type WIPE/), { target: { value: 'wipe' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await screen.findByRole('heading', { name: 'Meme Pals' });
    expect(s.lock.state.get()).toBe('disabled');
    expect(s.pairing.profile.get()).toBeNull();
  });
});

describe('formatWait', () => {
  it('rounds up to whole seconds', () => {
    expect(formatWait(30_000)).toBe('0:30');
    expect(formatWait(29_001)).toBe('0:30');
    expect(formatWait(300_000)).toBe('5:00');
    expect(formatWait(3_600_000)).toBe('1:00:00');
  });
});
