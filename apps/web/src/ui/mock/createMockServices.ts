import {
  decodePairingCode,
  encodePairingCode,
  generatePairingSecret,
  randomId,
  sha256Hex,
  ulid,
  type ConnectionState,
  type Message,
} from '@memes/shared';
import {
  DEFAULT_SETTINGS,
  type AppServices,
  type ChatMessage,
  type DeliveryStatus,
  type ImportImageInput,
  type LibraryMeme,
  type Profile,
  type ReactionSummary,
  type Settings,
} from '../../contracts';
import { writable } from '../../lib/store';
import { createDisabledLock } from '../../lib/disabledLock';
import { CAPTIONS, createMockMemeServices } from './mockMemes';
import { memeArt, svgBlob } from './placeholder';

/**
 * A complete, believable in-memory AppServices. Used by component tests and as
 * the "demo mode" of the app (open the app with ?demo or ?demo=paired).
 * Nothing here touches the network.
 */

export type MockScenario = 'fresh' | 'onboarded' | 'paired';

export interface MockOptions {
  scenario?: MockScenario;
  /** Multiplies every artificial delay. Use 0 in tests. Default 1. */
  timeScale?: number;
  myName?: string;
  partnerName?: string;
  /** Partner answers your messages, reacts to memes, and sometimes sends memes. Default true. */
  autoReply?: boolean;
  /** Whether the partner's device is "online" (so connection reaches 'connected'). Default true. */
  partnerOnline?: boolean;
  /** How long after "Show my code" the partner joins (ms, before timeScale). Default 6000. */
  partnerJoinMs?: number;
  /** 'paired' scenario: number of extra older filler messages (to exercise paging). Default 0. */
  extraHistory?: number;
}

export interface MockControls {
  /** Resolves once seeded history (if any) is in place. */
  ready: Promise<void>;
  setPartnerOnline(online: boolean): void;
  partnerSays(text: string, replyTo?: string): string;
  partnerSendsMeme(caption?: string): Promise<string>;
  partnerReacts(messageId: string, emoji: string): void;
  partnerTyping(active: boolean): void;
}

export type MockAppServices = AppServices & { demo: MockControls };

interface Rec {
  m: Message & { kind: 'text' | 'meme' };
  status: DeliveryStatus;
  /** authorId → emoji */
  reactions: Map<string, string>;
}

interface LibEntry {
  meta: LibraryMeme;
  blob: Blob | null;
  url?: string;
}

const PARTNER_TEXT_REPLIES = [
  'hahaha stop 😂',
  'ok this is literally us',
  'LMAO',
  'why is this so accurate',
  'sending this to my brain for safekeeping',
  'you have the best taste in memes',
  "I'm wheezing",
  'brb crying',
  'cannot believe you found this',
];
const PARTNER_QUESTION_REPLIES = ['hmm yes probably 😌', 'obviously yes', 'let me think… yes', 'ask me after dinner 🍝', 'only if you bring snacks'];
const PARTNER_HELLO_REPLIES = ['heyyy 👋', 'hi you ❤️', 'hello hello!'];
const PARTNER_MEME_REPLIES = ['😂😂😂', 'DEAD', 'ok this one is going in my favorites', 'how do you always find these', 'this is so you'];
const PARTNER_MEME_CAPTIONS = ['this is you', 'thought of you', 'too real', 'us tbh'];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function createMockServices(options: MockOptions = {}): MockAppServices {
  const scale = options.timeScale ?? 1;
  const scenario = options.scenario ?? 'fresh';
  const autoReply = options.autoReply ?? true;
  const partnerName = options.partnerName ?? 'Sam';
  const joinMs = options.partnerJoinMs ?? 6000;
  let partnerOnline = options.partnerOnline ?? true;
  let partnerJoined = scenario === 'paired';
  const partnerId = 'partner-' + randomId(6);

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms * scale);
    timers.add(t);
    return t;
  };
  const sleep = (ms: number) => new Promise<void>((r) => later(ms, r));
  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };

  // ─── State ────────────────────────────────────────────────────────────────
  const profile = writable<Profile | null>(null);
  const connection = writable<ConnectionState>('idle');
  const partnerTyping = writable(false);
  const messages = writable<ChatMessage[]>([]);
  const unreadCount = writable(0);
  const version = writable(0);
  const settings = writable<Settings>({ ...DEFAULT_SETTINGS, subreddits: [...DEFAULT_SETTINGS.subreddits] });

  const recs = new Map<string, Rec>();
  let order: string[] = [];
  let windowStart = 0;
  let readMarker = '';
  const viewCache = new Map<string, ChatMessage>();
  const library = new Map<string, LibEntry>();

  const myId = () => profile.get()?.deviceId ?? 'me';

  // ─── Chat projection ──────────────────────────────────────────────────────
  function toChat(r: Rec): ChatMessage {
    const cached = viewCache.get(r.m.id);
    if (cached) return cached;
    const me = myId();
    const counts = new Map<string, ReactionSummary>();
    for (const [author, emoji] of r.reactions) {
      const s = counts.get(emoji) ?? { emoji, count: 0, mine: false };
      s.count++;
      if (author === me) s.mine = true;
      counts.set(emoji, s);
    }
    let replyPreview: ChatMessage['replyPreview'];
    if (r.m.replyTo) {
      const t = recs.get(r.m.replyTo);
      if (t) replyPreview = { id: t.m.id, kind: t.m.kind, text: t.m.text, memeId: t.m.memeId, mine: t.m.authorId === me };
    }
    const view: ChatMessage = {
      ...r.m,
      mine: r.m.authorId === me,
      status: r.status,
      reactions: [...counts.values()],
      replyPreview,
    };
    viewCache.set(r.m.id, view);
    return view;
  }

  function publish() {
    messages.set(order.slice(windowStart).map((id) => toChat(recs.get(id)!)));
    const me = myId();
    let unread = 0;
    for (const id of order) if (id > readMarker && recs.get(id)!.m.authorId !== me) unread++;
    unreadCount.set(unread);
  }

  function touch(id: string) {
    viewCache.delete(id);
    for (const r of recs.values()) if (r.m.replyTo === id) viewCache.delete(r.m.id);
  }

  function insert(m: Rec['m'], status: DeliveryStatus): Rec {
    const r: Rec = { m, status, reactions: new Map() };
    recs.set(m.id, r);
    order.push(m.id);
    if (order.length > 1 && order[order.length - 2]! > m.id) order.sort();
    return r;
  }

  function setStatus(id: string, status: DeliveryStatus) {
    const r = recs.get(id);
    if (!r) return;
    const rank = { pending: 0, delivered: 1, read: 2 };
    if (rank[status] <= rank[r.status]) return;
    r.status = status;
    touch(id);
    publish();
  }

  // ─── Library ──────────────────────────────────────────────────────────────
  async function addToLibrary(input: ImportImageInput, opts: { pending?: boolean; savedAt?: number; favorite?: boolean } = {}) {
    const bytes = new Uint8Array(await input.blob.arrayBuffer());
    const id = await sha256Hex(bytes);
    const existing = library.get(id);
    if (existing) {
      if (!existing.blob && !opts.pending) existing.blob = input.blob;
      if (!existing.meta.title && input.title) existing.meta = { ...existing.meta, title: input.title };
      return existing;
    }
    const entry: LibEntry = {
      meta: {
        id,
        mime: input.mime,
        width: input.width,
        height: input.height,
        size: bytes.byteLength,
        source: input.source,
        sourceUrl: input.sourceUrl,
        title: input.title,
        savedAt: opts.savedAt ?? Date.now(),
        favorite: opts.favorite ?? false,
      },
      blob: opts.pending ? null : input.blob,
    };
    library.set(id, entry);
    return entry;
  }

  const bump = () => version.set(version.get() + 1);

  // ─── Connection simulation ────────────────────────────────────────────────
  function goConnected() {
    connection.set('connected');
    const me = myId();
    let delay = 300;
    for (const id of order) {
      const r = recs.get(id)!;
      if (r.m.authorId === me && r.status === 'pending') {
        later(delay, () => setStatus(id, 'delivered'));
        later(delay + 900, () => setStatus(id, 'read'));
        delay += 120;
      }
    }
  }

  function reconnect() {
    const p = profile.get();
    if (!p?.paired) {
      connection.set('idle');
      return;
    }
    connection.set('connecting');
    later(900, () => {
      if (!profile.get()?.paired) return;
      if (partnerOnline && partnerJoined) goConnected();
      else connection.set('waiting');
    });
  }

  function partnerJoin() {
    partnerJoined = true;
    const p = profile.get();
    if (!p?.paired) return;
    profile.set({ ...p, partnerName, partnerDeviceId: partnerId });
    if (partnerOnline) {
      goConnected();
      later(1200, () => partnerSays(`hi ${p.displayName}! it worked 🎉`));
    }
  }

  // ─── Partner behaviour ────────────────────────────────────────────────────
  function partnerSays(text: string, replyTo?: string): string {
    const m: Rec['m'] = { id: ulid(), authorId: partnerId, kind: 'text', text, replyTo, createdAt: Date.now() };
    insert(m, 'delivered');
    publish();
    return m.id;
  }

  async function partnerSendsMeme(caption?: string): Promise<string> {
    const [top, bottom] = pick(CAPTIONS);
    const art = memeArt(Math.floor(Math.random() * 1e9), top, bottom);
    const blob = svgBlob(art.svg);
    const entry = await addToLibrary(
      { blob, mime: 'image/svg+xml', width: art.width, height: art.height, source: 'reddit', title: `${top} / ${bottom}` },
      { pending: true },
    );
    const m: Rec['m'] = { id: ulid(), authorId: partnerId, kind: 'meme', memeId: entry.meta.id, text: caption, createdAt: Date.now() };
    insert(m, 'delivered');
    publish();
    bump();
    // The image bytes "arrive" over P2P a moment later.
    later(1800, () => {
      entry.blob = blob;
      bump();
    });
    return m.id;
  }

  function partnerReacts(messageId: string, emoji: string) {
    const r = recs.get(messageId);
    if (!r) return;
    if (emoji) r.reactions.set(partnerId, emoji);
    else r.reactions.delete(partnerId);
    touch(messageId);
    publish();
  }

  let replyTimers: ReturnType<typeof setTimeout>[] = [];
  function scheduleReply(trigger: Rec) {
    if (!autoReply || connection.get() !== 'connected') return;
    for (const t of replyTimers) {
      clearTimeout(t);
      timers.delete(t);
    }
    replyTimers = [];
    const isMeme = trigger.m.kind === 'meme';
    const text = (trigger.m.text ?? '').toLowerCase();
    if (isMeme) replyTimers.push(later(1600, () => partnerReacts(trigger.m.id, pick(['😂', '🔥', '❤️']))));
    replyTimers.push(later(2000, () => partnerTyping.set(true)));
    replyTimers.push(
      later(2000 + 1400 + Math.random() * 1200, () => {
        partnerTyping.set(false);
        if (connection.get() !== 'connected') return;
        if (!isMeme && Math.random() < 0.2) {
          void partnerSendsMeme(pick(PARTNER_MEME_CAPTIONS));
          return;
        }
        let reply: string;
        if (isMeme) reply = pick(PARTNER_MEME_REPLIES);
        else if (/\b(hi|hey|hello|yo)\b/.test(text)) reply = pick(PARTNER_HELLO_REPLIES);
        else if (/love/.test(text)) reply = 'love you more ❤️';
        else if (text.includes('?')) reply = pick(PARTNER_QUESTION_REPLIES);
        else reply = pick(PARTNER_TEXT_REPLIES);
        partnerSays(reply, Math.random() < 0.15 ? trigger.m.id : undefined);
      }),
    );
  }

  async function sendOwn(m: Rec['m']) {
    const r = insert(m, 'pending');
    publish();
    if (connection.get() === 'connected') {
      later(350, () => setStatus(m.id, 'delivered'));
      later(1300, () => setStatus(m.id, 'read'));
      scheduleReply(r);
    }
  }

  // ─── Seeding ──────────────────────────────────────────────────────────────
  async function seed() {
    if (scenario === 'fresh') return;
    const deviceId = 'dev-' + randomId(8);
    const me = options.myName ?? 'Jordan';
    if (scenario === 'onboarded') {
      profile.set({ deviceId, displayName: me, paired: false, createdAt: Date.now() });
      return;
    }
    profile.set({
      deviceId,
      displayName: me,
      paired: true,
      pairingCode: encodePairingCode(generatePairingSecret()),
      partnerName,
      partnerDeviceId: partnerId,
      createdAt: Date.now() - 5 * 86400_000,
    });

    const day = 86400_000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const t0 = startOfToday.getTime();
    const memeFor = async (seedNum: number, top: string, bottom: string, w: number, h: number, savedAt: number, favorite = false) => {
      const art = memeArt(seedNum, top, bottom, w, h);
      const e = await addToLibrary(
        { blob: svgBlob(art.svg), mime: 'image/svg+xml', width: w, height: h, source: 'reddit', title: `${top} / ${bottom}`, sourceUrl: `https://www.reddit.com/r/memes/comments/demo${seedNum}/` },
        { savedAt, favorite },
      );
      return e.meta.id;
    };

    type S = { at: number; who: 'me' | 'them'; text?: string; meme?: [number, string, string, number, number, boolean?]; react?: [string, string?]; replyToPrev?: boolean };
    const script: S[] = [
      { at: t0 - 2 * day + 19 * 3600_000 + 4 * 60_000, who: 'me', text: 'ok I installed it. is this thing on?' },
      { at: t0 - 2 * day + 19 * 3600_000 + 5 * 60_000, who: 'them', text: 'it works!! our own tiny meme kingdom 👑' },
      { at: t0 - 2 * day + 19 * 3600_000 + 6 * 60_000, who: 'me', meme: [11, 'when the code works', 'and you have no idea why', 800, 800], react: ['😂'] },
      { at: t0 - 2 * day + 19 * 3600_000 + 8 * 60_000, who: 'them', text: 'this is literally you at work', replyToPrev: true },
      { at: t0 - 2 * day + 21 * 3600_000 + 30 * 60_000, who: 'them', meme: [23, 'me opening the fridge', 'for the 9th time in an hour', 800, 1000, true], react: ['❤️', '😂'] },
      { at: t0 - 2 * day + 21 * 3600_000 + 31 * 60_000, who: 'me', text: 'I feel personally attacked' },
      { at: t0 - day + 8 * 3600_000 + 12 * 60_000, who: 'me', text: 'good morning ☀️ coffee date later?' },
      { at: t0 - day + 8 * 3600_000 + 40 * 60_000, who: 'them', text: 'yes please. 5pm at the usual spot?' },
      { at: t0 - day + 8 * 3600_000 + 41 * 60_000, who: 'me', text: 'perfect', react: ['👍'] },
      { at: t0 - day + 13 * 3600_000 + 2 * 60_000, who: 'them', meme: [37, 'monday morning', 'loading... please wait', 800, 800], react: ['🔥'] },
      { at: t0 - day + 13 * 3600_000 + 3 * 60_000, who: 'them', text: 'me in the meeting rn' },
      { at: t0 - day + 13 * 3600_000 + 9 * 60_000, who: 'me', text: 'hang in there 💪 only 4 more hours' },
      { at: t0 + 7 * 3600_000 + 51 * 60_000, who: 'them', text: 'did you see the one I saved last night?' },
      { at: t0 + 7 * 3600_000 + 53 * 60_000, who: 'me', meme: [51, 'me watching my partner', 'eat my fries', 800, 900, true], react: ['😂', '😂'] },
      { at: t0 + 7 * 3600_000 + 54 * 60_000, who: 'them', text: 'in my defense, they were RIGHT THERE 🍟' },
    ];
    const extra = options.extraHistory ?? 0;
    for (let i = 0; i < extra; i++) {
      const at = t0 - 3 * day - (extra - i) * 37 * 60_000;
      const who = i % 3 === 0 ? partnerId : deviceId;
      insert({ id: ulid(at), authorId: who, kind: 'text', text: `Older message #${i + 1}`, createdAt: at }, who === deviceId ? 'read' : 'delivered');
    }
    const ids: string[] = [];
    for (const s of script) {
      let memeId: string | undefined;
      if (s.meme) {
        const [n, top, bottom, w, h, fav] = s.meme;
        memeId = await memeFor(n, top, bottom, w, h, s.at, fav ?? false);
      }
      const m: Rec['m'] = {
        id: ulid(s.at),
        authorId: s.who === 'me' ? deviceId : partnerId,
        kind: memeId ? 'meme' : 'text',
        text: s.text,
        memeId,
        replyTo: s.replyToPrev ? ids[ids.length - 1] : undefined,
        createdAt: s.at,
      };
      const r = insert(m, s.who === 'me' ? 'read' : 'delivered');
      if (s.react) {
        const [a, b] = s.react;
        r.reactions.set(s.who === 'me' ? partnerId : deviceId, a);
        if (b) r.reactions.set(s.who === 'me' ? deviceId : partnerId, b);
      }
      ids.push(m.id);
    }
    // A few extra saved memes so the gallery isn't sparse.
    await memeFor(71, 'when the weekend', 'is finally here', 800, 800, t0 - 3 * day, true);
    await memeFor(83, 'my plants after I water them', 'once a month', 800, 1000, t0 - 3 * day - 3600_000);
    await memeFor(97, 'the last slice', 'of pizza', 800, 640, t0 - 4 * day, true);
    // Everything except the partner's last message has been read.
    readMarker = ids[ids.length - 2]!;
    windowStart = Math.max(0, order.length - 50);
    publish();
    bump();
    reconnect();
  }

  const ready = seed();

  // ─── Services ─────────────────────────────────────────────────────────────
  const memeServices = createMockMemeServices({ timeScale: scale });

  const services: MockAppServices = {
    ...memeServices,
    lock: createDisabledLock(),

    pairing: {
      profile,
      async setDisplayName(name) {
        const n = name.trim();
        if (!n) throw new Error('name-required');
        if (n.length > 40) throw new Error('name-too-long');
        await sleep(150);
        const p = profile.get();
        profile.set(p ? { ...p, displayName: n } : { deviceId: 'dev-' + randomId(8), displayName: n, paired: false, createdAt: Date.now() });
        if (p) touchAll();
      },
      async createPairing() {
        const p = profile.get();
        if (!p) throw new Error('no-profile');
        await sleep(250);
        const code = encodePairingCode(generatePairingSecret());
        partnerJoined = false;
        profile.set({ ...p, paired: true, pairingCode: code, partnerName: undefined, partnerDeviceId: undefined });
        connection.set('connecting');
        later(700, () => {
          if (profile.get()?.pairingCode === code && !partnerJoined) connection.set('waiting');
        });
        later(joinMs, () => {
          if (profile.get()?.pairingCode === code) partnerJoin();
        });
        return code;
      },
      async acceptPairing(code) {
        const p = profile.get();
        if (!p) throw new Error('no-profile');
        const secret = decodePairingCode(code);
        await sleep(300);
        if (!secret) throw new Error('invalid-code');
        const normalized = encodePairingCode(secret);
        partnerJoined = false;
        profile.set({ ...p, paired: true, pairingCode: normalized, partnerName: undefined, partnerDeviceId: undefined });
        connection.set('connecting');
        later(1500, () => {
          if (profile.get()?.pairingCode === normalized) partnerJoin();
        });
      },
      async unpair() {
        await sleep(150);
        clearTimers();
        const p = profile.get();
        if (p) profile.set({ deviceId: p.deviceId, displayName: p.displayName, createdAt: p.createdAt, paired: false });
        partnerJoined = false;
        partnerTyping.set(false);
        connection.set('idle');
      },
      async wipe() {
        await sleep(200);
        clearTimers();
        for (const e of library.values()) if (e.url?.startsWith('blob:')) URL.revokeObjectURL(e.url);
        library.clear();
        recs.clear();
        viewCache.clear();
        order = [];
        windowStart = 0;
        readMarker = '';
        partnerJoined = false;
        profile.set(null);
        connection.set('idle');
        partnerTyping.set(false);
        settings.set({ ...DEFAULT_SETTINGS, subreddits: [...DEFAULT_SETTINGS.subreddits] });
        publish();
        bump();
      },
    },

    chat: {
      connection,
      partnerTyping,
      messages,
      unreadCount,
      async loadOlder() {
        await sleep(500);
        if (windowStart <= 0) return false;
        windowStart = Math.max(0, windowStart - 30);
        publish();
        return true;
      },
      async sendText(text, replyTo) {
        const t = text.trim();
        if (!t) return;
        if (t.length > 10_000) throw new Error('message-too-long');
        await sendOwn({ id: ulid(), authorId: myId(), kind: 'text', text: t, replyTo, createdAt: Date.now() });
      },
      async sendMeme(memeId, caption, replyTo) {
        if (!library.has(memeId)) throw new Error('meme-not-in-library');
        await sendOwn({ id: ulid(), authorId: myId(), kind: 'meme', memeId, text: caption, replyTo, createdAt: Date.now() });
      },
      async react(messageId, emoji) {
        const r = recs.get(messageId);
        if (!r) return;
        const me = myId();
        if (!emoji || r.reactions.get(me) === emoji) r.reactions.delete(me);
        else r.reactions.set(me, emoji);
        touch(messageId);
        publish();
      },
      setTyping() {
        /* the mock partner doesn't care */
      },
      markRead() {
        const me = myId();
        for (let i = order.length - 1; i >= windowStart; i--) {
          const id = order[i]!;
          if (recs.get(id)!.m.authorId !== me) {
            if (id > readMarker) {
              readMarker = id;
              publish();
            }
            break;
          }
        }
      },
    },

    library: {
      version,
      async importImage(input) {
        const e = await addToLibrary(input);
        bump();
        return e.meta;
      },
      async get(memeId) {
        return library.get(memeId)?.meta;
      },
      async getUrl(memeId) {
        const e = library.get(memeId);
        if (!e?.blob) return null;
        if (!e.url) {
          try {
            e.url = URL.createObjectURL(e.blob);
          } catch {
            e.url = await blobToDataUrl(e.blob);
          }
        }
        return e.url;
      },
      async list(opts = {}) {
        const q = opts.query?.trim().toLowerCase();
        let all = [...library.values()].map((e) => e.meta);
        if (opts.favoritesOnly) all = all.filter((m) => m.favorite);
        if (q) all = all.filter((m) => (m.title ?? '').toLowerCase().includes(q) || m.source.includes(q));
        all.sort((a, b) => b.savedAt - a.savedAt);
        return opts.limit ? all.slice(0, opts.limit) : all;
      },
      async toggleFavorite(memeId) {
        const e = library.get(memeId);
        if (!e) throw new Error('not-found');
        e.meta = { ...e.meta, favorite: !e.meta.favorite };
        bump();
        return e.meta.favorite;
      },
      async remove(memeId) {
        const e = library.get(memeId);
        if (!e) return;
        if (e.url?.startsWith('blob:')) URL.revokeObjectURL(e.url);
        library.delete(memeId);
        bump();
      },
    },

    settings: {
      settings,
      async update(patch) {
        settings.set({ ...settings.get(), ...patch });
      },
    },

    backup: {
      async exportBackup() {
        const memes = [];
        for (const e of library.values()) {
          memes.push({ meta: e.meta, data: e.blob ? await blobToBase64(e.blob) : null });
        }
        const data = {
          kind: 'meme-pals-backup',
          version: 1,
          exportedAt: new Date().toISOString(),
          profile: profile.get(),
          settings: settings.get(),
          messages: order.map((id) => {
            const r = recs.get(id)!;
            return { ...r.m, status: r.status, reactions: Object.fromEntries(r.reactions) };
          }),
          memes,
        };
        return new Blob([JSON.stringify(data)], { type: 'application/json' });
      },
      async importBackup(file) {
        let data: {
          kind?: string;
          messages?: (Rec['m'] & { status?: DeliveryStatus; reactions?: Record<string, string> })[];
          memes?: { meta: LibraryMeme; data: string | null }[];
        };
        try {
          data = JSON.parse(await file.text());
        } catch {
          throw new Error('invalid-backup');
        }
        if (data?.kind !== 'meme-pals-backup') throw new Error('invalid-backup');
        let nMemes = 0;
        let nMsgs = 0;
        for (const m of data.memes ?? []) {
          if (library.has(m.meta.id)) continue;
          library.set(m.meta.id, { meta: m.meta, blob: m.data ? base64ToBlob(m.data, m.meta.mime) : null });
          nMemes++;
        }
        for (const m of data.messages ?? []) {
          if (recs.has(m.id)) continue;
          const { status, reactions, ...msg } = m;
          const r = insert(msg, status ?? 'delivered');
          for (const [k, v] of Object.entries(reactions ?? {})) r.reactions.set(k, v);
          nMsgs++;
        }
        publish();
        bump();
        return { messages: nMsgs, memes: nMemes };
      },
    },

    async dispose() {
      clearTimers();
    },

    demo: {
      ready,
      setPartnerOnline(online) {
        partnerOnline = online;
        if (!profile.get()?.paired) return;
        if (!online) {
          partnerTyping.set(false);
          if (connection.get() === 'connected') connection.set('waiting');
        } else if (partnerJoined) reconnect();
      },
      partnerSays,
      partnerSendsMeme,
      partnerReacts,
      partnerTyping: (a) => partnerTyping.set(a),
    },
  };

  function touchAll() {
    viewCache.clear();
    publish();
  }

  return services;
}

/** Parse demo options from a URL query, e.g. "?demo=paired&dark". */
export function mockOptionsFromQuery(search: string): MockOptions {
  const q = new URLSearchParams(search);
  const scenario = q.get('demo') as MockScenario | null;
  return {
    scenario: scenario === 'paired' || scenario === 'onboarded' ? scenario : 'fresh',
    timeScale: q.has('fast') ? 0.2 : 1,
    partnerOnline: q.get('partner') !== 'offline',
    extraHistory: Math.min(5000, Math.max(0, Number(q.get('history')) || 0)),
  };
}

