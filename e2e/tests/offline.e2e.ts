import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bubble,
  bubbleTexts,
  pairedDevices,
  sendText,
  startEnv,
  T,
  tickOf,
  token,
  until,
  waitBubble,
  waitOnline,
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

describe('offline / outbox', () => {
  it('B closes the app; A’s 3 messages wait as pending, then arrive in order when B comes back', async () => {
    await b.page.close();
    // A notices B is gone.
    await a.page.locator('.chat-top .topbar-sub', { hasText: /^offline$/ }).waitFor({ timeout: T.sync });
    await a.page.getByText(/is offline\. Messages will be delivered/).waitFor({ timeout: T.ui });

    const texts = [token('one-'), token('two-'), token('three-')];
    for (const t of texts) await sendText(a.page, t);
    for (const t of texts) {
      await waitBubble(a.page, t);
      expect(await tickOf(bubble(a.page, t))).toBe('Sending');
    }

    // B opens the app again (same context = same IndexedDB).
    await b.reopen();
    await b.page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: T.ui });
    await waitOnline(b.page);
    for (const t of texts) await waitBubble(b.page, t);
    const order = (await bubbleTexts(b.page)).filter((x) => texts.includes(x));
    expect(order).toEqual(texts);

    // A's ticks move on (B is on the chat screen, so straight through to Read).
    for (const t of texts) await waitTick(bubble(a.page, t), 'Read');
  });

  it('B goes offline (network emulation) while A sends; messages sync after B is back', async () => {
    // Offline emulation cuts the relay WebSocket; the WebRTC link may or may not survive it.
    // Either way nothing may be lost and order must hold.
    await b.context.setOffline(true);
    const texts = [token('net-one-'), token('net-two-'), token('net-three-')];
    for (const t of texts) await sendText(a.page, t);
    await b.context.setOffline(false);
    // Reload so B certainly reconnects through the relay.
    await b.page.reload();
    await waitOnline(b.page);
    for (const t of texts) await waitBubble(b.page, t);
    expect((await bubbleTexts(b.page)).filter((x) => texts.includes(x))).toEqual(texts);
    for (const t of texts) await waitTick(bubble(a.page, t), 'Read');
  });

  it('the relay restarts mid-session: the pair keeps chatting and re-signals through the new relay', async () => {
    await env.restartRelay();

    // Existing P2P link (or a fresh one after reconnect) still carries messages both ways.
    const x = token('after-restart-a-');
    await sendText(a.page, x);
    await waitBubble(b.page, x);
    const y = token('after-restart-b-');
    await sendText(b.page, y);
    await waitBubble(a.page, y);

    // Both clients rejoin the new relay's room (it starts with no state at all)...
    await until(() => env.relay.stats().joined === 2 && env.relay.stats().rooms === 1, 'both clients to rejoin the restarted relay', 45_000);
    // ...so a full reconnect (B reloads) is negotiated by the restarted relay.
    await b.page.reload();
    await waitOnline(b.page);
    await waitOnline(a.page);
    const z = token('after-reload-');
    await sendText(b.page, z);
    await waitBubble(a.page, z);
  });

  it('messages sent while the relay is down are delivered once it is back', async () => {
    await env.stopRelay();
    await b.page.close();
    const t = token('relay-down-');
    await sendText(a.page, t);
    await waitBubble(a.page, t);
    expect(await tickOf(bubble(a.page, t))).toBe('Sending');
    await env.startRelay();
    await b.reopen();
    await waitOnline(b.page, 45_000);
    await waitBubble(b.page, t, 45_000);
    await waitTick(bubble(a.page, t), 'Read', 45_000);
  });
});
