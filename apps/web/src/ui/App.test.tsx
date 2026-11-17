// @vitest-environment jsdom
import { encodePairingCode, generatePairingSecret } from '@memes/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createMockServices, type MockAppServices, type MockOptions } from './mock/createMockServices';

let services: MockAppServices | null = null;

function setup(opts: MockOptions = {}) {
  services = createMockServices({ timeScale: 0.01, autoReply: false, partnerJoinMs: 1e9, ...opts });
  const utils = render(<App services={services} />);
  return { services, ...utils };
}

beforeEach(() => {
  history.replaceState(null, '', '/');
});

afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = null;
  delete document.documentElement.dataset.theme;
});

const tab = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('onboarding → pairing', () => {
  it('asks for a name, then shows a QR pairing code and live status', async () => {
    const { services } = setup();
    expect(screen.getByRole('heading', { name: 'Meme Pals' })).toBeTruthy();

    // Empty name is rejected
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/enter a name/i);

    fireEvent.change(screen.getByLabelText(/What should your partner call you/), { target: { value: 'Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'Pair with your partner' });
    expect(services.pairing.profile.get()?.displayName).toBe('Jordan');

    fireEvent.click(screen.getByRole('button', { name: /Show my code/ }));
    const qr = await screen.findByAltText(/QR code for pairing code/);
    const code = services.pairing.profile.get()?.pairingCode;
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByLabelText('Pairing code').textContent).toBe(code);
    await screen.findByText('Waiting for your partner…');

    // Partner hasn't joined: the user can still go ahead.
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));
    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  it('advances automatically once the partner connects', async () => {
    setup({ partnerJoinMs: 200 });
    fireEvent.change(screen.getByLabelText(/What should your partner call you/), { target: { value: 'Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: /Show my code/ }));
    await screen.findByRole('heading', { name: "You're paired!" });
    expect(screen.getByText('Say hi to Sam.')).toBeTruthy();
    await screen.findByRole('textbox', { name: 'Message' }, { timeout: 3000 });
  });

  it('joining shows invalid-code errors nicely, then pairs with a valid code', async () => {
    setup({ scenario: 'onboarded' });
    fireEvent.click(await screen.findByRole('button', { name: /Join my partner/ }));
    const input = screen.getByLabelText('Pairing code');

    fireEvent.change(input, { target: { value: 'NOT-A-CODE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/doesn't look right/);

    fireEvent.change(input, { target: { value: encodePairingCode(generatePairingSecret()).toLowerCase() } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await screen.findByRole('heading', { name: "You're paired!" });
    fireEvent.click(screen.getByRole('button', { name: 'Start chatting' }));
    expect(await screen.findByRole('heading', { name: 'Sam' })).toBeTruthy();
  });
});

describe('chat', () => {
  it('sending a text shows it in the conversation', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    const box = await screen.findByRole('textbox', { name: 'Message' });

    fireEvent.change(box, { target: { value: 'pizza tonight? 🍕' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const list = screen.getByRole('list', { name: 'Messages' });
    const bubble = await within(list).findByText('pizza tonight? 🍕');
    expect((box as HTMLTextAreaElement).value).toBe('');
    const li = bubble.closest('li')!;
    expect(li.className).toContain('mine');
    // Status ticks progress pending → delivered → read
    await waitFor(() => expect(within(li).getByLabelText('Read')).toBeTruthy());
  });

  it('Shift+Enter does not send', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    const box = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(within(screen.getByRole('list', { name: 'Messages' })).queryByText('line one')).toBeNull();
  });

  it('a reaction appears under the message', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    await screen.findByRole('list', { name: 'Messages' });
    act(() => void services.demo.partnerSays('react to this one'));
    const li = (await screen.findByText('react to this one')).closest('li')!;

    fireEvent.click(within(li).getByRole('button', { name: 'React' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Message actions' })).getByRole('button', { name: 'React with 🔥' }));

    const chip = await within(li).findByRole('button', { name: '🔥 1, including you' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('toolbar', { name: 'Message actions' })).toBeNull();

    // Tapping my reaction again removes it.
    fireEvent.click(chip);
    await waitFor(() => expect(within(li).queryByRole('button', { name: /🔥/ })).toBeNull());
  });

  it('replying shows a quoted preview', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    await screen.findByRole('list', { name: 'Messages' });
    act(() => void services.demo.partnerSays('what should we watch'));
    const li = (await screen.findByText('what should we watch')).closest('li')!;
    fireEvent.click(within(li).getByRole('button', { name: 'Reply' }));
    expect(screen.getByText('Replying to Sam')).toBeTruthy();

    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'the cooking show' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const mine = (await screen.findByText('the cooking show')).closest('li')!;
    expect(within(mine).getByRole('button', { name: /Reply to Sam: what should we watch/ })).toBeTruthy();
  });

  it('shows the unread badge and a connection banner when the partner is offline', async () => {
    const { services } = setup({ scenario: 'paired', partnerOnline: false });
    await services.demo.ready;
    fireEvent.click(tab('Discover'));
    act(() => void services.demo.partnerSays('psst'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Chat, \d+ unread/ })).toBeTruthy());
    expect(await screen.findByText(/Sam is offline/)).toBeTruthy();
  });
});

describe('settings', () => {
  it('toggling the theme updates settings and <html data-theme>', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    fireEvent.click(tab('Settings'));
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });

    fireEvent.click(within(group).getByLabelText(/Dark/));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(services.settings.settings.get().theme).toBe('dark');

    fireEvent.click(within(group).getByLabelText(/Light/));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));

    fireEvent.click(within(group).getByLabelText('System'));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
  });

  it('validates subreddit names', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    fireEvent.click(tab('Settings'));
    const input = await screen.findByLabelText('Add a subreddit');
    fireEvent.change(input, { target: { value: 'not a sub!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toMatch(/2–32 letters/);

    fireEvent.change(input, { target: { value: 'r/aww' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(services.settings.settings.get().subreddits).toContain('aww'));
  });

  it('wipe asks for confirmation and returns to onboarding', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    fireEvent.click(tab('Settings'));
    fireEvent.click(await screen.findByRole('button', { name: 'Wipe all data' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Wipe all data?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(services.pairing.profile.get()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Wipe all data' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Wipe everything' }));
    await screen.findByLabelText(/What should your partner call you/);
  });
});

describe('gallery', () => {
  it('filters favorites, and un-favoriting removes a meme from that view', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    fireEvent.click(tab('Gallery'));

    const all = await screen.findByRole('list', { name: 'All memes' });
    const total = (await services.library.list()).length;
    const favs = (await services.library.list({ favoritesOnly: true })).length;
    expect(favs).toBeGreaterThan(0);
    expect(favs).toBeLessThan(total);
    await waitFor(() => expect(within(all).getAllByRole('listitem')).toHaveLength(total));

    fireEvent.click(screen.getByLabelText(/Favorites/));
    const favList = await screen.findByRole('list', { name: 'Favorite memes' });
    await waitFor(() => expect(within(favList).getAllByRole('listitem')).toHaveLength(favs));

    // Open one and un-favorite it from the viewer.
    fireEvent.click(within(favList).getAllByRole('button')[0]!);
    const unfav = await screen.findByRole('button', { name: /Favorited/ });
    fireEvent.click(unfav);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Favorite memes' })).getAllByRole('listitem')).toHaveLength(favs - 1));
  });
});

describe('discover', () => {
  it('loads a feed, hides NSFW posts, and sends a post to the partner', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    fireEvent.click(tab('Discover'));
    await waitFor(() => expect(document.querySelectorAll('.tile').length).toBeGreaterThan(0));
    expect(document.querySelectorAll('.badge-nsfw').length).toBe(0);

    const before = services.chat.messages.get().length;
    fireEvent.click(document.querySelector('.tile')!);
    fireEvent.click(await screen.findByRole('button', { name: /Send to Sam/ }));
    await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(services.chat.messages.get().length).toBe(before + 1));
    const last = services.chat.messages.get().at(-1)!;
    expect(last.kind).toBe('meme');
    expect((await services.library.get(last.memeId!))?.source).toBe('reddit');
  });

  it('shows a friendly "not found" state', async () => {
    const { services } = setup({ scenario: 'paired' });
    await services.demo.ready;
    await act(() => services.settings.update({ subreddits: ['doesnotexist'] }));
    fireEvent.click(tab('Discover'));
    expect(await screen.findByRole('heading', { name: 'r/doesnotexist not found' })).toBeTruthy();
  });
});
