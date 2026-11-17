import { encodePairingCode, generatePairingSecret } from '@memes/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockServices, mockOptionsFromQuery, type MockAppServices } from './createMockServices';
import { svgBlob } from './placeholder';

let s: MockAppServices;
afterEach(() => s?.dispose());

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('mock services', () => {
  it('goes through onboarding and pairing states', async () => {
    s = createMockServices({ timeScale: 0.01, partnerJoinMs: 10_000 });
    expect(s.pairing.profile.get()).toBeNull();
    await s.pairing.setDisplayName('  Alex ');
    expect(s.pairing.profile.get()).toMatchObject({ displayName: 'Alex', paired: false });
    await expect(s.pairing.acceptPairing('nope')).rejects.toThrow('invalid-code');

    const code = await s.pairing.createPairing();
    expect(s.pairing.profile.get()).toMatchObject({ paired: true, pairingCode: code });
    expect(s.chat.connection.get()).toBe('connecting');
    await until(() => s.chat.connection.get() === 'waiting');
    await until(() => s.chat.connection.get() === 'connected');
    expect(s.pairing.profile.get()?.partnerName).toBe('Sam');

    await s.pairing.unpair();
    expect(s.pairing.profile.get()).toMatchObject({ paired: false, displayName: 'Alex' });
    expect(s.chat.connection.get()).toBe('idle');
  });

  it('accepts a valid code and connects', async () => {
    s = createMockServices({ scenario: 'onboarded', timeScale: 0.01 });
    await s.pairing.acceptPairing(encodePairingCode(generatePairingSecret()));
    await until(() => s.chat.connection.get() === 'connected');
  });

  it('sends, delivers and reads messages; reactions toggle', async () => {
    s = createMockServices({ scenario: 'paired', timeScale: 0.01, autoReply: false });
    await s.demo.ready;
    await until(() => s.chat.connection.get() === 'connected');
    const before = s.chat.messages.get().length;
    await s.chat.sendText('hello');
    const mine = s.chat.messages.get().at(-1)!;
    expect(s.chat.messages.get()).toHaveLength(before + 1);
    expect(mine).toMatchObject({ kind: 'text', text: 'hello', mine: true, status: 'pending' });
    await until(() => s.chat.messages.get().at(-1)!.status === 'read');

    await s.chat.react(mine.id, '😂');
    expect(s.chat.messages.get().at(-1)!.reactions).toEqual([{ emoji: '😂', count: 1, mine: true }]);
    s.demo.partnerReacts(mine.id, '😂');
    expect(s.chat.messages.get().at(-1)!.reactions).toEqual([{ emoji: '😂', count: 2, mine: true }]);
    await s.chat.react(mine.id, '😂');
    expect(s.chat.messages.get().at(-1)!.reactions).toEqual([{ emoji: '😂', count: 1, mine: false }]);
  });

  it('keeps messages pending while the partner is offline', async () => {
    s = createMockServices({ scenario: 'paired', timeScale: 0.01, autoReply: false, partnerOnline: false });
    await s.demo.ready;
    await until(() => s.chat.connection.get() === 'waiting');
    await s.chat.sendText('you there?');
    await new Promise((r) => setTimeout(r, 50));
    expect(s.chat.messages.get().at(-1)!.status).toBe('pending');
    s.demo.setPartnerOnline(true);
    await until(() => s.chat.messages.get().at(-1)!.status === 'read');
  });

  it('tracks unread partner messages and markRead clears them', async () => {
    s = createMockServices({ scenario: 'paired', timeScale: 0.01, autoReply: false });
    await s.demo.ready;
    const start = s.chat.unreadCount.get();
    s.demo.partnerSays('one');
    s.demo.partnerSays('two');
    expect(s.chat.unreadCount.get()).toBe(start + 2);
    s.chat.markRead();
    expect(s.chat.unreadCount.get()).toBe(0);
  });

  it('partner memes arrive later (getUrl null until then)', async () => {
    s = createMockServices({ scenario: 'paired', timeScale: 0.01, autoReply: false });
    await s.demo.ready;
    const v = s.library.version.get();
    await s.demo.partnerSendsMeme();
    const m = s.chat.messages.get().at(-1)!;
    expect(m.kind).toBe('meme');
    expect(await s.library.getUrl(m.memeId!)).toBeNull();
    await until(() => s.library.version.get() > v + 1);
    expect(await s.library.getUrl(m.memeId!)).toBeTruthy();
  });

  it('library dedupes by content and supports favorites, search, remove', async () => {
    s = createMockServices({ timeScale: 0 });
    const blob = svgBlob('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const a = await s.library.importImage({ blob, mime: 'image/svg+xml', width: 10, height: 10, source: 'upload', title: 'Tiny cat' });
    const b = await s.library.importImage({ blob, mime: 'image/svg+xml', width: 10, height: 10, source: 'upload' });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.library.list()).toHaveLength(1);
    expect(await s.library.toggleFavorite(a.id)).toBe(true);
    expect(await s.library.list({ favoritesOnly: true })).toHaveLength(1);
    expect(await s.library.list({ query: 'CAT' })).toHaveLength(1);
    expect(await s.library.list({ query: 'dog' })).toHaveLength(0);
    await s.library.remove(a.id);
    expect(await s.library.list()).toHaveLength(0);
  });

  it('backup export/import round-trips', async () => {
    const src = createMockServices({ scenario: 'paired', timeScale: 0 });
    await src.demo.ready;
    const blob = await src.backup.exportBackup();
    s = createMockServices({ scenario: 'onboarded', timeScale: 0 });
    const r = await s.backup.importBackup(blob);
    expect(r.messages).toBe(src.chat.messages.get().length);
    expect(r.memes).toBe((await src.library.list()).length);
    expect(await s.backup.importBackup(blob)).toEqual({ messages: 0, memes: 0 });
    await expect(s.backup.importBackup(new Blob(['{}']))).rejects.toThrow('invalid-backup');
    await src.dispose();
  });

  it('wipe clears everything', async () => {
    s = createMockServices({ scenario: 'paired', timeScale: 0 });
    await s.demo.ready;
    await s.settings.update({ theme: 'dark' });
    await s.pairing.wipe();
    expect(s.pairing.profile.get()).toBeNull();
    expect(s.chat.messages.get()).toHaveLength(0);
    expect(await s.library.list()).toHaveLength(0);
    expect(s.settings.settings.get().theme).toBe('system');
  });

  it('fake reddit pages, errors and templates', async () => {
    s = createMockServices({ timeScale: 0 });
    const p1 = await s.reddit.fetchPage('memes');
    expect(p1.posts.length).toBeGreaterThan(0);
    expect(p1.after).toBeTruthy();
    const p2 = await s.reddit.fetchPage('memes', { after: p1.after });
    expect(p2.posts[0]!.id).not.toBe(p1.posts[0]!.id);
    await expect(s.reddit.fetchPage('doesnotexist')).rejects.toThrow('subreddit-not-found');
    const img = await s.images.fetchImage(p1.posts[0]!.imageUrl);
    expect(img).toMatchObject({ mime: 'image/svg+xml', width: p1.posts[0]!.width, height: p1.posts[0]!.height });

    const templates = await s.imgflip.listTemplates();
    expect(templates.length).toBeGreaterThan(5);
    const t = templates.find((x) => x.boxCount === 2)!;
    const boxes = s.images.defaultBoxes(t);
    expect(boxes).toHaveLength(2);
    const out = await s.images.renderMeme(t, boxes.map((b) => ({ ...b, text: 'hi' })));
    expect(out.width).toBe(t.width);
    expect(await out.blob.text()).toContain('HI');
  });

  it('parses demo options from the query string', () => {
    expect(mockOptionsFromQuery('?demo=paired&partner=offline')).toMatchObject({ scenario: 'paired', partnerOnline: false });
    expect(mockOptionsFromQuery('')).toMatchObject({ scenario: 'fresh', partnerOnline: true });
  });
});
