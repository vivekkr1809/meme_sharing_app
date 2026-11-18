/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bubble,
  goTab,
  pairedDevices,
  sendText,
  startEnv,
  T,
  tickOf,
  token,
  waitBubble,
  waitTick,
  type Device,
  type Env,
} from '../support/harness';

let env: Env;
let a: Device;
let b: Device;

beforeAll(async () => {
  env = await startEnv();
  [a, b] = await pairedDevices(env);
});
afterAll(async () => {
  await env?.close();
});

/** Long-press equivalent: the bubble's context menu opens the "Message actions" tray. */
async function actions(d: Device, li: any) {
  await li.locator('.bubble').click({ button: 'right' });
  await d.page.getByRole('toolbar', { name: 'Message actions' }).waitFor({ timeout: T.ui });
}

describe('chat', () => {
  const t1 = token('hello-from-a-');
  const t2 = token('hi-back-from-b-');

  it('text both ways, and reply quoting', async () => {
    await sendText(a.page, t1);
    const onB = await waitBubble(b.page, t1);
    expect(await onB.getAttribute('class')).toContain('theirs');
    expect(await bubble(a.page, t1).getAttribute('class')).toContain('mine');

    await sendText(b.page, t2);
    await waitBubble(a.page, t2);

    // B replies to A's message.
    // Phones have no hover tools: long-press (context menu) opens the action tray.
    await actions(b, onB);
    await b.page.getByRole('toolbar', { name: 'Message actions' }).getByRole('button', { name: 'Reply' }).click();
    await b.page.getByText(`Replying to ${a.name}`).waitFor({ timeout: T.ui });
    const reply = token('reply-');
    await sendText(b.page, reply);

    const mineOnB = await waitBubble(b.page, reply);
    await mineOnB.getByRole('button', { name: `Reply to ${a.name}: ${t1}` }).waitFor({ timeout: T.ui });
    const onA = await waitBubble(a.page, reply);
    await onA.getByRole('button', { name: `Reply to you: ${t1}` }).waitFor({ timeout: T.ui });
  });

  it('a reaction appears on the other side', async () => {
    const li = bubble(a.page, t2);
    await actions(a, li);
    await a.page.getByRole('toolbar', { name: 'Message actions' }).getByRole('button', { name: 'React with 🔥' }).click();
    await li.getByRole('button', { name: '🔥 1, including you' }).waitFor({ timeout: T.ui });

    const onB = bubble(b.page, t2);
    await onB.getByRole('button', { name: '🔥 1', exact: true }).waitFor({ timeout: T.sync });

    // B adds the same emoji: both see a count of 2.
    await onB.getByRole('button', { name: '🔥 1', exact: true }).click();
    await onB.getByRole('button', { name: '🔥 2, including you' }).waitFor({ timeout: T.sync });
    await li.getByRole('button', { name: '🔥 2, including you' }).waitFor({ timeout: T.sync });

    // A removes theirs.
    await li.getByRole('button', { name: '🔥 2, including you' }).click();
    await onB.getByRole('button', { name: '🔥 1, including you' }).waitFor({ timeout: T.sync });
  });

  it('typing indicator', async () => {
    const box = b.page.getByRole('textbox', { name: 'Message' });
    await box.fill('I am typi');
    await a.page.getByRole('status', { name: `${b.name} is typing` }).waitFor({ timeout: T.sync });
    await a.page.locator('.chat-top .topbar-sub', { hasText: 'typing…' }).waitFor({ timeout: T.ui });

    await box.fill('');
    await a.page.getByRole('status', { name: `${b.name} is typing` }).waitFor({ state: 'detached', timeout: T.sync });
    await a.page.locator('.chat-top .topbar-sub', { hasText: /^online$/ }).waitFor({ timeout: T.ui });
  });

  it('delivery and read ticks, and the unread badge while on another tab', async () => {
    await goTab(b.page, 'Discover');
    const t3 = token('while-you-browse-');
    await sendText(a.page, t3);
    const li = bubble(a.page, t3);
    await waitTick(li, 'Delivered');

    // B is not looking at the chat: badge, and A's tick stays at Delivered.
    const nav = b.page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('button', { name: 'Chat, 1 unread' }).waitFor({ timeout: T.sync });
    await b.page.waitForFunction(() => document.title === '(1) Meme Pals', null, { timeout: T.ui });
    const t4 = token('and-another-');
    await sendText(a.page, t4);
    await nav.getByRole('button', { name: 'Chat, 2 unread' }).waitFor({ timeout: T.sync });
    await waitTick(bubble(a.page, t4), 'Delivered');
    expect(await tickOf(li)).toBe('Delivered');

    // B opens the chat: messages are read, the badge clears, A sees Read.
    await goTab(b.page, 'Chat');
    await waitBubble(b.page, t4);
    await waitTick(bubble(a.page, t4), 'Read');
    await waitTick(li, 'Read');
    await nav.getByRole('button', { name: 'Chat', exact: true }).waitFor({ timeout: T.ui });
    await b.page.waitForFunction(() => document.title === 'Meme Pals', null, { timeout: T.ui });
  });
});
