import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bubbleTexts,
  goTab,
  idbAll,
  pairedDevices,
  sendText,
  startEnv,
  T,
  token,
  waitBubble,
  waitOnline,
  type Device,
  type Env,
  type Page,
} from '../support/harness';

/** Passcode lock (A8) on the real build: two Chromium contexts, real PBKDF2 (600k), real WebRTC. */

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

const PASSCODE = '135790';

async function enableLock(page: Page, code: string): Promise<void> {
  await goTab(page, 'Settings');
  const section = page.getByRole('region', { name: 'Passcode lock' });
  await section.getByRole('button', { name: /Turn on passcode lock/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Turn on passcode lock' });
  await dialog.getByLabel('New passcode').fill(code);
  await dialog.getByLabel('Type it again').fill(code);
  await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
  await section.getByText(/^On\./).waitFor({ timeout: T.sync });
}

/** Every row of every object store, as JSON (ArrayBuffers as latin1 text), read straight from IndexedDB. */
async function rawDump(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('memes');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = [...db.objectStoreNames];
          const tx = db.transaction(names, 'readonly');
          const out: string[] = [];
          for (const n of names) {
            const req = tx.objectStore(n).getAll();
            req.onsuccess = () => {
              for (const row of req.result) {
                out.push(
                  JSON.stringify(row, (_k, v) => (v instanceof ArrayBuffer ? String.fromCharCode(...new Uint8Array(v).subarray(0, 4096)) : v)),
                );
              }
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(out.join('\n'));
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

describe('passcode lock', () => {
  it('encrypts at rest, locks on reload, rejects a wrong passcode, and unlocks into the intact chat', async () => {
    const before = [token('lock-a-'), token('lock-b-')];
    await sendText(a.page, before[0]!);
    await waitBubble(b.page, before[0]!);
    await sendText(b.page, before[1]!);
    await waitBubble(a.page, before[1]!);

    const plainBefore = await rawDump(a.page);
    expect(plainBefore).toContain(before[0]);
    expect(plainBefore).toContain(b.name);

    await enableLock(a.page, PASSCODE);

    // Nothing readable is left in IndexedDB: no message text, no names, no pairing secret.
    const raw = await rawDump(a.page);
    for (const s of [...before, a.name, b.name]) expect(raw).not.toContain(s);
    const [profile] = await idbAll(a.page, 'profile');
    expect(profile.secret).toMatchObject({ $enc: 1 });
    expect(profile.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect((await idbAll(a.page, 'lock'))[0]).toMatchObject({ kdf: { name: 'PBKDF2', iterations: 600_000 } });

    // Reload: the lock screen, and nothing else.
    await a.page.reload();
    await a.page.getByRole('heading', { name: 'Meme Pals is locked' }).waitFor({ timeout: T.ui });
    expect(await a.page.getByRole('navigation', { name: 'Main' }).count()).toBe(0);
    expect(await a.page.getByLabel('Passcode').getAttribute('inputmode')).toBe('numeric');

    // The partner writes while we are locked; it waits in the partner's outbox.
    const whileLocked = token('while-locked-');
    await sendText(b.page, whileLocked);

    await a.page.getByLabel('Passcode').fill('000000');
    await a.page.getByRole('button', { name: /Unlock/ }).click();
    await a.page.getByRole('alert').filter({ hasText: "That passcode isn't right." }).waitFor({ timeout: T.ui });
    expect(await a.page.getByRole('heading', { name: 'Meme Pals is locked' }).count()).toBe(1);

    await a.page.getByLabel('Passcode').fill(PASSCODE);
    await a.page.getByRole('button', { name: /Unlock/ }).click();
    await a.page.getByRole('navigation', { name: 'Main' }).waitFor({ timeout: T.sync });
    await goTab(a.page, 'Chat');
    await waitOnline(a.page);
    await waitBubble(a.page, whileLocked);
    expect(await bubbleTexts(a.page)).toEqual(expect.arrayContaining([...before, whileLocked]));
    await a.page.getByRole('heading', { name: b.name, level: 1 }).waitFor({ timeout: T.ui });

    // Sync works both ways after unlocking, and new rows are encrypted too.
    const after = token('after-unlock-');
    await sendText(a.page, after);
    await waitBubble(b.page, after);
    expect(await rawDump(a.page)).not.toContain(after);
    expect(await rawDump(a.page)).not.toContain(whileLocked);
  });

  it('Lock now from Settings stops syncing until the passcode is entered again', async () => {
    await goTab(a.page, 'Settings');
    await a.page.getByRole('region', { name: 'Passcode lock' }).getByRole('button', { name: /Lock now/ }).click();
    await a.page.getByRole('heading', { name: 'Meme Pals is locked' }).waitFor({ timeout: T.ui });
    await b.page.locator('.chat-top .topbar-sub', { hasText: /^online$/ }).waitFor({ state: 'detached', timeout: T.sync });

    const msg = token('after-lock-now-');
    await sendText(b.page, msg);
    await a.page.getByLabel('Passcode').fill(PASSCODE);
    await a.page.getByRole('button', { name: /Unlock/ }).click();
    await a.page.getByRole('navigation', { name: 'Main' }).waitFor({ timeout: T.sync });
    await goTab(a.page, 'Chat');
    await waitBubble(a.page, msg);
  });
});
