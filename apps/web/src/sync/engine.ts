import Dexie from 'dexie';
import {
  MAX_FUTURE_SKEW_MS,
  PBKDF2_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  PROTOCOL_VERSION,
  decodePairingCode,
  deriveKeys,
  encodePairingCode,
  exportRawKey,
  fromBase64Url,
  generateDataKey,
  generatePairingSecret,
  importRawKey,
  newKdfParams,
  randomId,
  toBase64Url,
  ulid,
  ulidTime,
  type ConnectionState,
  type ControlFrame,
  type Message,
} from '@memes/shared';
import { writable } from '../lib/store';
import type {
  BackupService,
  LockService,
  ChatService,
  CreateDataServicesOptions,
  DataServices,
  LockState,
  PairingService,
  Profile,
  Settings,
  SettingsService,
  Transport,
  TransportEvents,
  Unsubscribe,
} from '../contracts';
import { applyBackup, buildBackup, readBackup, serializeBackup } from '../db/backup';
import { assertBackupPassword, encryptBackup } from '../db/backupCrypto';
import { AtRestCrypto, rewriteAll } from '../db/atRest';
import { MemeStore } from '../db/library';
import {
  backoffMs,
  cleanLockRow,
  defaultLockRow,
  isValidAutoLockMinutes,
  isWeakPasscode,
  parseLockRow,
  unwrapDataKey,
  wrapDataKey,
  type LockRow,
} from '../db/lock';
import { requestPersistentStorage } from '../db/persist';
import { MemesDB, toMessage, toMessageRow, type MessageRow, type ProfileRow } from '../db/schema';
import { mergeSettings, sanitizeSettings } from '../db/settings';
import { ChatView } from './chatView';

/** Extra knobs (beyond the contract) for tests. */
export interface EngineTuning {
  /** Partner typing indicator auto-expires after this long without a refresh. Default 6000. */
  typingExpiryMs?: number;
  /** While typing, re-send `typing: true` at most this often. Default 3000. */
  typingRefreshMs?: number;
  /** Chat window page size. Default 50. */
  pageSize?: number;
  /** PBKDF2 iterations for a new passcode. Default PBKDF2_ITERATIONS; tests use a few thousand. */
  kdfIterations?: number;
  /** Clock for the lock (attempt back-off, auto-lock). Default Date.now. */
  now?: () => number;
  /** Source of `visibilitychange` for auto-lock. Default: `document` in browsers; null disables it. */
  visibility?: VisibilitySource | null;
}

/** The part of `document` that auto-lock needs. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', cb: () => void): void;
  removeEventListener(type: 'visibilitychange', cb: () => void): void;
}

export type EngineOptions = CreateDataServicesOptions & EngineTuning;

const MAX_TEXT = 10_000;
const MAX_NAME = 64;

/**
 * Implementation of DataServices: owns the Dexie DB, the Transport and the sync protocol.
 *
 * Concurrency model: every mutation (local API call, incoming frame, incoming blob, transport
 * restart) runs on a single promise queue (`serial`). That makes the sync rules easy to reason
 * about (no interleaved read-modify-write) and keeps the in-memory view model consistent with
 * the DB. Read-only library calls bypass the queue.
 */
export class Engine implements DataServices {
  private db: MemesDB;
  private readonly dbName: string;
  private readonly profileStore = writable<Profile | null>(null);
  private readonly connectionStore = writable<ConnectionState>('idle');
  private readonly typingStore = writable(false);
  private readonly unreadStore = writable(0);
  private readonly settingsStore = writable<Settings>(mergeSettings(undefined));
  private readonly view: ChatView;
  private readonly memes: MemeStore;

  private row: ProfileRow | null = null;
  private transport: Transport | null = null;
  private transportSubs: Unsubscribe[] = [];
  private transportState: ConnectionState = 'idle';
  /** Newest message id received from the partner (sent in `hello`). */
  private lastReceivedId: string | null = null;
  /** meme-wants sent on the current connection (avoid duplicates). */
  private wantInflight = new Set<string>();
  /** Memes we are currently sending in response to `meme-want` (one transfer per meme at a time). */
  private sendingBlobs = new Set<string>();
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private typingSent = { active: false, at: 0 };
  private chain: Promise<unknown> = Promise.resolve();
  private ops = 0;
  private disposed = false;
  /**
   * The partner pin for the current connection: set once a `hello` from the paired partner
   * device (or, before any partner is known, the first one) arrives. Until then every other
   * frame and blob is ignored, so a device that only knows the pairing secret can't pose as
   * the partner. Reset on every connection state change.
   */
  private peerVerified = false;

  // Passcode lock (see ../db/lock.ts and ../db/atRest.ts).
  private readonly atRest = new AtRestCrypto();
  private readonly lockStore = writable<LockState>('disabled');
  private readonly autoLockStore = writable(defaultLockRow().autoLockMinutes);
  private readonly retryStore = writable(0);
  private lockRow: LockRow = defaultLockRow();
  /** The record claims a passcode but its KDF params / wrapped key are invalid. */
  private lockDamaged = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenAt: number | null = null;

  private readonly typingExpiryMs: number;
  private readonly typingRefreshMs: number;
  private readonly kdfIterations: number;
  private readonly minKdfIterations: number;
  private readonly now: () => number;
  private readonly visibility: VisibilitySource | null;

  readonly pairing: PairingService;
  readonly chat: ChatService;
  readonly library: MemeStore;
  readonly settings: SettingsService;
  readonly backup: BackupService;
  readonly lock: LockService;

  static async create(opts: EngineOptions): Promise<Engine> {
    const e = new Engine(opts);
    await e.init();
    return e;
  }

  private constructor(private readonly opts: EngineOptions) {
    this.dbName = opts.dbName ?? 'memes';
    this.db = new MemesDB(this.dbName, this.atRest);
    this.typingExpiryMs = opts.typingExpiryMs ?? 6000;
    this.typingRefreshMs = opts.typingRefreshMs ?? 3000;
    this.kdfIterations = opts.kdfIterations ?? PBKDF2_ITERATIONS;
    this.minKdfIterations = Math.min(PBKDF2_MIN_ITERATIONS, this.kdfIterations);
    this.now = opts.now ?? (() => Date.now());
    const doc = (globalThis as { document?: VisibilitySource }).document;
    this.visibility = opts.visibility !== undefined ? opts.visibility : doc && typeof doc.addEventListener === 'function' ? doc : null;
    this.memes = new MemeStore(
      () => this.db,
      () => this.assertUnlocked(),
    );
    this.library = this.memes;
    this.view = new ChatView(
      () => this.db,
      {
        me: () => this.row?.deviceId ?? '',
        peerReadId: () => this.row?.peerReadId ?? null,
        myReadId: () => this.row?.lastReadId ?? null,
      },
      opts.pageSize ?? 50,
    );

    this.pairing = {
      profile: this.profileStore,
      setDisplayName: (name) => this.guarded(() => this.setDisplayName(name)),
      createPairing: () =>
        this.guarded(async () => {
          const secret = generatePairingSecret();
          await this.pairWith(secret);
          return encodePairingCode(secret);
        }),
      acceptPairing: (code) => {
        if (this.isLocked()) return Promise.reject(new Error('locked'));
        const secret = typeof code === 'string' ? decodePairingCode(code) : null;
        if (!secret) return Promise.reject(new Error('invalid-code'));
        return this.guarded(() => this.pairWith(secret));
      },
      unpair: () => this.guarded(() => this.unpair()),
      // Deliberately not guarded: "Forgot passcode? Wipe this device" works while locked.
      wipe: () => this.serial(() => this.wipe()),
    };

    this.chat = {
      connection: this.connectionStore,
      partnerTyping: this.typingStore,
      messages: this.view.messages,
      unreadCount: this.unreadStore,
      loadOlder: () =>
        this.guarded(async () => {
          const more = await this.view.loadOlder();
          this.view.publish();
          return more;
        }),
      sendText: (text, replyTo) =>
        this.guarded(async () => {
          if (typeof text !== 'string' || !text.trim()) throw new Error('empty-message');
          if (text.length > MAX_TEXT) throw new Error('too-long');
          await this.createOwn({ kind: 'text', text, replyTo });
        }),
      sendMeme: (memeId, caption, replyTo) =>
        this.guarded(async () => {
          const meta = (await this.memes.getMetas([memeId])).get(memeId);
          if (!meta) throw new Error('unknown-meme');
          if (caption !== undefined && caption.length > MAX_TEXT) throw new Error('too-long');
          await this.createOwn({ kind: 'meme', memeId, text: caption || undefined, replyTo });
        }),
      react: (messageId, emoji) => this.guarded(() => this.react(messageId, emoji)),
      // setTyping / markRead are fire-and-forget: while locked they are no-ops (nothing is loaded).
      setTyping: (active) => this.setTyping(active),
      markRead: () => {
        if (!this.isLocked()) this.enqueue(() => this.markRead());
      },
    };

    this.settings = {
      settings: this.settingsStore,
      update: (patch) => this.guarded(() => this.updateSettings(patch)),
    };

    this.lock = {
      state: this.lockStore,
      autoLockMinutes: this.autoLockStore,
      retryAfterMs: this.retryStore,
      enable: (passcode) => this.serial(() => this.enableLock(passcode)),
      disable: (passcode) => this.serial(() => this.disableLock(passcode)),
      change: (oldPasscode, newPasscode) => this.serial(() => this.changePasscode(oldPasscode, newPasscode)),
      unlock: (passcode) => this.serial(() => this.unlock(passcode)),
      lockNow: () => this.serial(async () => this.lockNow()),
      setAutoLockMinutes: (minutes) => this.serial(() => this.setAutoLockMinutes(minutes)),
    };

    this.backup = {
      exportBackup: async (opts) => {
        const password = opts?.password;
        if (password !== undefined) assertBackupPassword(password);
        // Read the DB on the queue; encrypt (PBKDF2 + AES-GCM) off it so sync isn't blocked meanwhile.
        const plain = await this.serial(async () => serializeBackup(await buildBackup(this.db)));
        return password === undefined ? new Blob([plain], { type: 'application/json' }) : encryptBackup(plain, password);
      },
      importBackup: async (file, opts) => {
        const prepared = await readBackup(file, opts?.password);
        return this.serial(async () => {
          const before = this.settingsStore.get().relayUrl;
          const deviceBefore = this.row?.deviceId;
          const res = await applyBackup(this.db, prepared);
          await this.loadState();
          this.memes.bump();
          const identityChanged = this.row?.deviceId !== deviceBefore;
          if (this.row?.secret && (identityChanged || this.settingsStore.get().relayUrl !== before)) {
            await this.restartTransport();
          }
          else if (this.isConnected()) {
            await this.flushOutbox();
            await this.requestMissing();
          }
          return res;
        });
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.visibility?.removeEventListener('visibilitychange', this.onVisibility);
    this.clearAutoLockTimer();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.detachTransport();
    this.clearTypingTimer();
    await this.chain.catch(() => {});
    this.memes.revokeAll();
    this.db.close();
  }

  // ─── queue ───────────────────────────────────────────────────────────────

  /** Total operations ever queued (tests use it to detect quiescence). */
  get opCount(): number {
    return this.ops;
  }

  /** Resolves once the operation queue has drained (tests). */
  async whenIdle(): Promise<void> {
    let c: Promise<unknown>;
    do {
      c = this.chain;
      await c;
    } while (c !== this.chain);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.ops++;
    const p = this.chain.then(() => {
      if (this.disposed) throw new Error('disposed');
      return fn();
    });
    this.chain = p.catch(() => {});
    return p;
  }

  /** Like serial(), but refuses with Error('locked') while the passcode lock is closed. */
  private guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isLocked()) return Promise.reject(new Error('locked'));
    return this.serial(() => {
      this.assertUnlocked();
      return fn();
    });
  }

  private isLocked(): boolean {
    return this.lockStore.get() === 'locked';
  }

  private assertUnlocked(): void {
    if (this.isLocked()) throw new Error('locked');
  }

  private enqueue(fn: () => Promise<void>): void {
    this.serial(fn).catch((err) => {
      if (!this.disposed) console.error('[sync]', err);
    });
  }

  // ─── lifecycle / state ─────────────────────────────────────────────────

  private async init(): Promise<void> {
    requestPersistentStorage();
    await this.db.open();
    await this.loadLock();
    this.visibility?.addEventListener('visibilitychange', this.onVisibility);
    if (this.isLocked()) {
      // Nothing personal is loaded until unlock(): only the (plaintext) settings, for the theme.
      await this.loadSettings();
      return;
    }
    await this.loadState();
    if (this.row?.secret) await this.serial(() => this.restartTransport());
  }

  private async loadSettings(): Promise<void> {
    this.settingsStore.set(mergeSettings((await this.db.settings.get('settings'))?.value));
  }

  /** (Re)load all in-memory state from the DB. */
  private async loadState(): Promise<void> {
    const db = this.db;
    this.row = (await db.profile.get('me')) ?? null;
    await this.loadSettings();
    this.publishProfile();
    this.lastReceivedId = await this.computeLastReceived();
    await this.view.loadLatest();
    this.view.publish();
    await this.recountUnread();
  }

  private async computeLastReceived(): Promise<string | null> {
    const me = this.row?.deviceId;
    if (!me) return null;
    const last = await this.db.messages
      .toCollection()
      .reverse()
      .filter((m) => m.authorId !== me)
      .first();
    return last?.id ?? null;
  }

  private publishProfile(): void {
    const r = this.row;
    if (!r) {
      this.profileStore.set(null);
      return;
    }
    const p: Profile = { deviceId: r.deviceId, displayName: r.displayName, paired: !!r.secret, createdAt: r.createdAt };
    if (r.secret) p.pairingCode = encodePairingCode(fromBase64Url(r.secret));
    if (r.partnerName !== undefined) p.partnerName = r.partnerName;
    if (r.partnerDeviceId !== undefined) p.partnerDeviceId = r.partnerDeviceId;
    this.profileStore.set(p);
  }

  private async saveProfile(row: ProfileRow): Promise<void> {
    await this.db.profile.put(row);
    this.row = row;
    this.publishProfile();
  }

  private async recountUnread(): Promise<void> {
    const me = this.row?.deviceId;
    if (!me) {
      this.unreadStore.set(0);
      return;
    }
    const from = this.row?.lastReadId;
    const n = await this.db.messages
      .where('[lane+id]')
      .between(['c', from ?? Dexie.minKey], ['c', Dexie.maxKey], from === undefined, true)
      .filter((m) => m.authorId !== me)
      .count();
    this.unreadStore.set(n);
  }

  // ─── transport ──────────────────────────────────────────────────────────

  private isConnected(): boolean {
    return this.transportState === 'connected' && !!this.transport;
  }

  private send(frame: ControlFrame): boolean {
    return this.isConnected() ? this.transport!.send(frame) : false;
  }

  private detachTransport(): void {
    for (const u of this.transportSubs) u();
    this.transportSubs = [];
    const t = this.transport;
    this.transport = null;
    t?.stop();
    this.onState('idle');
  }

  /** Stop any current transport and start a new one for the stored secret + current relay. */
  private async restartTransport(): Promise<void> {
    this.detachTransport();
    const secret = this.row?.secret;
    const deviceId = this.row?.deviceId;
    if (!secret || !deviceId || this.disposed) return;
    const keys = await deriveKeys(fromBase64Url(secret));
    if (this.disposed || this.row?.secret !== secret) return;
    const t = this.opts.createTransport({
      relayUrl: this.settingsStore.get().relayUrl || this.opts.defaultRelayUrl,
      keys,
      deviceId,
      iceServers: this.opts.iceServers,
    });
    this.transport = t;
    const mine = () => this.transport === t;
    this.transportSubs = [
      t.on('state', (s) => {
        if (mine()) this.onState(s);
      }),
      t.on('frame', (f) => {
        if (mine()) this.enqueue(() => this.handleFrame(f));
      }),
      t.on('blob', (b) => {
        if (mine()) this.enqueue(() => this.handleBlob(b));
      }),
    ];
    t.start();
    if (mine()) this.onState(t.state);
  }

  private onState(s: ConnectionState): void {
    if (s === this.transportState) return;
    this.transportState = s;
    this.peerVerified = false;
    this.connectionStore.set(s);
    if (s === 'connected') {
      this.enqueue(() => this.sendHello());
    } else {
      this.setPartnerTyping(false);
      this.wantInflight.clear();
      this.typingSent = { active: false, at: 0 };
    }
  }

  private async sendHello(): Promise<void> {
    const r = this.row;
    if (!r || !this.isConnected()) return;
    this.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      deviceId: r.deviceId,
      displayName: r.displayName,
      lastReceivedId: this.lastReceivedId,
      lastReadId: r.lastReadId ?? null,
    });
  }

  // ─── incoming ───────────────────────────────────────────────────────────

  private async handleFrame(f: ControlFrame): Promise<void> {
    if (!this.row) return;
    if (f.type !== 'hello' && !this.peerVerified) {
      console.warn(`[sync] ignoring ${f.type} before a hello from the paired partner`);
      return;
    }
    switch (f.type) {
      case 'hello':
        return this.onHello(f);
      case 'msg':
        return this.onMsg(f.message, f.meme);
      case 'ack':
        return this.onAck(f.ids);
      case 'meme-want':
        return this.onMemeWant(f.memeId);
      case 'meme-missing':
        this.wantInflight.delete(f.memeId);
        return;
      case 'typing':
        this.setPartnerTyping(f.active);
        return;
      case 'read':
        return this.onPeerRead(f.upToId);
      case 'profile':
        return this.updatePartner({ partnerName: f.displayName.slice(0, MAX_NAME) });
    }
  }

  private async onHello(f: Extract<ControlFrame, { type: 'hello' }>): Promise<void> {
    const r = this.row!;
    if (f.deviceId === r.deviceId) {
      console.warn('[sync] ignoring hello that claims our own deviceId');
      return;
    }
    // Partner pinning: once a partner device is known, only that device may say hello. Anyone
    // else holding the pairing secret (a leaked code) is ignored instead of replacing the
    // partner and receiving our outbox and history. Re-pairing (a new secret) clears the pin.
    const pinned = r.partnerDeviceId;
    if (pinned && f.deviceId !== pinned) {
      console.warn('[sync] ignoring hello from a device other than the paired partner');
      return;
    }
    this.peerVerified = true;
    if (f.v !== PROTOCOL_VERSION) console.warn(`[sync] partner protocol v${f.v}, ours v${PROTOCOL_VERSION}`);
    await this.updatePartner({ partnerName: f.displayName.slice(0, MAX_NAME), partnerDeviceId: f.deviceId });
    if (f.lastReadId) await this.onPeerRead(f.lastReadId);

    // Rule 2: stream every own message newer than the peer's watermark, plus everything still
    // in the outbox (covers frames lost mid-flight below the watermark), oldest first.
    const me = r.deviceId;
    const newer = await this.db.messages
      .where('[authorId+id]')
      .between([me, f.lastReceivedId ?? Dexie.minKey], [me, Dexie.maxKey], false, true)
      .toArray();
    const seen = new Set(newer.map((m) => m.id));
    const outIds = ((await this.db.outbox.toCollection().primaryKeys()) as string[]).filter((id) => !seen.has(id));
    const fromOutbox = (await this.db.messages.bulkGet(outIds)).filter((m): m is MessageRow => !!m && m.authorId === me);
    const all = [...newer, ...fromOutbox].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    await this.sendMessages(all);
    await this.requestMissing();
  }

  private async onMsg(m: Message, meme: Extract<ControlFrame, { type: 'msg' }>['meme']): Promise<void> {
    const me = this.row!.deviceId;
    if (m.authorId === me) {
      console.warn('[sync] ignoring msg that claims our deviceId as author');
      return;
    }
    // R-06: once the partner has said hello, only accept messages authored by that device.
    const partner = this.row!.partnerDeviceId;
    if (partner && m.authorId !== partner) {
      console.warn('[sync] ignoring msg whose author is not the paired partner');
      return;
    }
    if (isFarFuture(m.id)) {
      // Not acked: the partner keeps it in its outbox and retries once clocks agree.
      console.warn('[sync] ignoring msg whose id is too far in the future');
      return;
    }
    const existing = await this.db.messages.get(m.id);
    let unreadChanged = false;
    if (!existing) {
      const row = toMessageRow(m, { receivedAt: Date.now() });
      await this.db.messages.put(row);
      if (!this.lastReceivedId || m.id > this.lastReceivedId) this.lastReceivedId = m.id;
      await this.view.ingest(row);
      if (row.lane === 'c') {
        this.setPartnerTyping(false);
        unreadChanged = true;
      }
    }
    if (m.kind === 'meme' && m.memeId) {
      const missing = await this.memes.noteReferenced(m.memeId, meme);
      if (missing) this.want(m.memeId);
    }
    this.send({ type: 'ack', ids: [m.id] });
    if (unreadChanged) await this.recountUnread();
    this.view.publish();
  }

  private async onAck(ids: string[]): Promise<void> {
    const me = this.row!.deviceId;
    const db = this.db;
    const rows = (await db.messages.bulkGet(ids)).filter((r): r is MessageRow => !!r && r.authorId === me);
    if (!rows.length) return;
    const now = Date.now();
    const updated = rows.filter((r) => r.deliveredAt === undefined).map((r) => ({ ...r, deliveredAt: now }));
    await db.transaction('rw', db.messages, db.outbox, async () => {
      if (updated.length) await db.messages.bulkPut(updated);
      await db.outbox.bulkDelete(rows.map((r) => r.id));
    });
    for (const u of updated) await this.view.ingest(u);
    this.view.publish();
  }

  private async onPeerRead(upToId: string): Promise<void> {
    const r = this.row!;
    if (isFarFuture(upToId)) return;
    if (r.peerReadId && upToId <= r.peerReadId) return;
    await this.saveProfile({ ...r, peerReadId: upToId });
    this.view.invalidateAll();
    this.view.publish();
  }

  private async onMemeWant(memeId: string): Promise<void> {
    // A repeated want for a meme that is already being sent is a no-op. Without this, a
    // flood of wants would load (and queue) one full copy of the bytes per request.
    if (this.sendingBlobs.has(memeId)) return;
    // R-05: only serve memes that were actually shared in the chat, never the private library.
    const shared = await this.db.messages.where('memeId').equals(memeId).count();
    if (!shared) {
      this.send({ type: 'meme-missing', memeId });
      return;
    }
    const t = this.transport;
    const blob = await this.memes.getData(memeId);
    if (!blob || !t || !this.isConnected()) {
      this.send({ type: 'meme-missing', memeId });
      return;
    }
    this.sendingBlobs.add(memeId);
    // Not awaited: a large transfer must not block the frame queue.
    t.sendBlob(memeId, blob.mime, blob.data)
      .catch((err) => console.warn('[sync] sendBlob failed', memeId, err))
      .finally(() => this.sendingBlobs.delete(memeId));
  }

  private async handleBlob(b: TransportEvents['blob']): Promise<void> {
    if (!this.row || !this.peerVerified) return;
    this.wantInflight.delete(b.memeId);
    await this.memes.acceptBlob(b.memeId, b.mime, b.data);
  }

  private async updatePartner(patch: Pick<ProfileRow, 'partnerName'> & Partial<Pick<ProfileRow, 'partnerDeviceId'>>) {
    const r = this.row!;
    const next = { ...r, ...patch };
    if (next.partnerName === r.partnerName && next.partnerDeviceId === r.partnerDeviceId) return;
    await this.saveProfile(next);
  }

  private setPartnerTyping(active: boolean): void {
    this.clearTypingTimer();
    this.typingStore.set(active);
    if (active) this.typingTimer = setTimeout(() => this.typingStore.set(false), this.typingExpiryMs);
  }

  private clearTypingTimer(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = null;
  }

  // ─── outgoing ───────────────────────────────────────────────────────────

  private want(memeId: string): void {
    if (this.wantInflight.has(memeId) || !this.isConnected()) return;
    if (this.send({ type: 'meme-want', memeId })) this.wantInflight.add(memeId);
  }

  /** Re-request every referenced-but-missing meme (after reconnects and reloads). */
  private async requestMissing(): Promise<void> {
    if (!this.isConnected()) return;
    for (const id of await this.memes.missingIds()) this.want(id);
  }

  /** Send own messages as `msg` frames and record the attempt on their outbox entries. */
  private async sendMessages(rows: MessageRow[]): Promise<void> {
    if (!rows.length || !this.isConnected()) return;
    const memeIds = [...new Set(rows.filter((r) => r.kind === 'meme' && r.memeId).map((r) => r.memeId!))];
    const metas = memeIds.length ? await this.memes.getMetas(memeIds) : new Map();
    const sent: string[] = [];
    for (const r of rows) {
      const frame: ControlFrame = { type: 'msg', message: toMessage(r) };
      const meta = r.memeId ? metas.get(r.memeId) : undefined;
      if (meta) frame.meme = meta;
      if (!this.send(frame)) break;
      sent.push(r.id);
    }
    if (!sent.length) return;
    const db = this.db;
    const now = Date.now();
    await db.transaction('rw', db.outbox, async () => {
      const entries = await db.outbox.bulkGet(sent);
      const updates = entries.filter((e) => !!e).map((e) => ({ ...e!, attempts: e!.attempts + 1, lastTriedAt: now }));
      if (updates.length) await db.outbox.bulkPut(updates);
    });
  }

  private async flushOutbox(): Promise<void> {
    const ids = (await this.db.outbox.toCollection().primaryKeys()) as string[];
    const rows = (await this.db.messages.bulkGet(ids)).filter((m): m is MessageRow => !!m);
    await this.sendMessages(rows.sort((a, b) => (a.id < b.id ? -1 : 1)));
  }

  private async createOwn(fields: Omit<Message, 'id' | 'authorId' | 'createdAt'>): Promise<void> {
    const r = this.row;
    if (!r) throw new Error('no-profile');
    const m: Message = { id: ulid(), authorId: r.deviceId, createdAt: Date.now(), ...stripUndefined(fields) };
    const row = toMessageRow(m);
    const db = this.db;
    await db.transaction('rw', db.messages, db.outbox, async () => {
      await db.messages.put(row);
      await db.outbox.put({ id: m.id, attempts: 0, lastTriedAt: 0 });
    });
    await this.view.ingest(row);
    this.view.publish();
    // The receiver clears its typing indicator on a new message; mirror that here.
    if (row.lane === 'c') this.typingSent = { active: false, at: 0 };
    await this.sendMessages([row]);
  }

  private async react(messageId: string, emoji: string): Promise<void> {
    const r = this.row;
    if (!r) throw new Error('no-profile');
    if (typeof emoji !== 'string' || emoji.length > 32) throw new Error('invalid-emoji');
    const mine = await this.db.messages
      .where('[lane+replyTo]')
      .equals(['r', messageId])
      .filter((x) => x.authorId === r.deviceId)
      .toArray();
    const current = mine.reduce<MessageRow | undefined>((best, x) => (!best || x.id > best.id ? x : best), undefined);
    const currentEmoji = current?.emoji ?? '';
    const next = currentEmoji === emoji ? '' : emoji;
    if (next === currentEmoji) return; // removing a reaction that isn't there
    await this.createOwn({ kind: 'reaction', replyTo: messageId, emoji: next });
  }

  private setTyping(active: boolean): void {
    if (!this.isConnected()) return;
    const now = Date.now();
    if (active) {
      if (this.typingSent.active && now - this.typingSent.at < this.typingRefreshMs) return;
    } else if (!this.typingSent.active) {
      return;
    }
    if (this.send({ type: 'typing', active })) this.typingSent = { active, at: now };
  }

  private async markRead(): Promise<void> {
    const r = this.row;
    if (!r) return;
    const newest = this.view.newestPartnerId();
    if (!newest || (r.lastReadId && newest <= r.lastReadId)) return;
    await this.saveProfile({ ...r, lastReadId: newest });
    this.send({ type: 'read', upToId: newest });
    this.view.invalidateAll();
    this.view.publish();
    await this.recountUnread();
  }

  // ─── pairing / profile / settings ───────────────────────────────────────

  private ensureProfile(): ProfileRow {
    return this.row ?? { key: 'me', deviceId: randomId(16), displayName: '', createdAt: Date.now() };
  }

  private async setDisplayName(name: string): Promise<void> {
    const n = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
    if (!n) throw new Error('empty-name');
    const r = this.ensureProfile();
    if (r.displayName === n && this.row) return;
    await this.saveProfile({ ...r, displayName: n });
    this.send({ type: 'profile', displayName: n });
  }

  private async pairWith(secret: Uint8Array): Promise<void> {
    // A new secret starts a new pairing: forget the pinned partner device (it pins again on
    // the first hello under the new secret).
    const { partnerDeviceId: _unpinned, ...base } = this.ensureProfile();
    await this.saveProfile({ ...base, secret: toBase64Url(secret) });
    await this.restartTransport();
  }

  private async unpair(): Promise<void> {
    this.detachTransport();
    if (!this.row) return;
    const { secret: _forgotten, ...rest } = this.row;
    await this.saveProfile(rest);
  }

  private async wipe(): Promise<void> {
    this.detachTransport();
    this.clearTypingTimer();
    this.clearAutoLockTimer();
    this.memes.revokeAll();
    await this.db.delete();
    this.atRest.reset();
    this.db = new MemesDB(this.dbName, this.atRest);
    await this.db.open();
    this.wantInflight.clear();
    this.typingSent = { active: false, at: 0 };
    this.typingStore.set(false);
    await this.loadLock();
    await this.loadState();
    this.memes.bump();
  }

  private async updateSettings(patch: Partial<Settings>): Promise<void> {
    const prev = this.settingsStore.get();
    const next = mergeSettings({ ...prev, ...sanitizeSettings(patch) });
    await this.db.settings.put({ key: 'settings', value: next });
    this.settingsStore.set(next);
    if (next.relayUrl !== prev.relayUrl && this.row?.secret) await this.restartTransport();
  }

  // ─── passcode lock ──────────────────────────────────────────────────────
  //
  // All lock operations run on the serial queue, so no other operation sees the key or the
  // lock state change under it. See ../db/lock.ts (record, back-off) and ../db/atRest.ts.

  /** Read and validate the lock record; decides the initial state (locked when a passcode is set). */
  private async loadLock(): Promise<void> {
    const loaded = parseLockRow(await this.db.lock.get('lock'), this.now(), this.minKdfIterations);
    this.lockRow = loaded.row;
    this.lockDamaged = loaded.damaged;
    this.autoLockStore.set(loaded.row.autoLockMinutes);
    this.atRest.key = null;
    this.atRest.encryptWrites = loaded.enabled;
    this.lockStore.set(loaded.enabled ? 'locked' : 'disabled');
    this.updateRetry();
  }

  private async putLockRow(row: LockRow): Promise<void> {
    const clean = cleanLockRow(row);
    await this.db.lock.put(clean);
    this.lockRow = clean;
    this.autoLockStore.set(clean.autoLockMinutes);
  }

  /** Publish retryAfterMs and keep it counting down to 0. */
  private updateRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ms = Math.max(0, this.lockRow.lockedUntil - this.now());
    this.retryStore.set(ms);
    if (ms > 0 && !this.disposed) this.retryTimer = setTimeout(() => this.updateRetry(), Math.min(1000, ms));
  }

  /**
   * Check a passcode against the wrapped data key and return the raw key bytes.
   * The failure is recorded *before* the (slow) check, so reloading mid-attempt doesn't
   * reset the count; a success clears it. Never wipes anything.
   */
  private async verifyPasscode(passcode: string): Promise<Uint8Array> {
    if (this.lockRow.lockedUntil > this.now()) {
      this.updateRetry();
      throw new Error('too-many-attempts');
    }
    const failures = this.lockRow.failures + 1;
    await this.putLockRow({ ...this.lockRow, failures, lockedUntil: this.now() + backoffMs(failures) });
    const { kdf, wrappedKey } = this.lockRow;
    let raw: Uint8Array | null = null;
    if (typeof passcode === 'string' && kdf && wrappedKey && !this.lockDamaged) {
      raw = await unwrapDataKey(wrappedKey, passcode, kdf).catch(() => null);
    }
    if (!raw) {
      // Restart the wait from now (the check itself takes a moment).
      await this.putLockRow({ ...this.lockRow, lockedUntil: this.now() + backoffMs(failures) });
      this.updateRetry();
      throw new Error('wrong-passcode');
    }
    await this.putLockRow({ ...this.lockRow, failures: 0, lockedUntil: 0 });
    this.updateRetry();
    return raw;
  }

  private async enableLock(passcode: string): Promise<void> {
    if (isWeakPasscode(passcode)) throw new Error('weak-passcode');
    if (this.lockStore.get() !== 'disabled') throw new Error('already-enabled');
    const kdf = newKdfParams(this.kdfIterations);
    const raw = await exportRawKey(await generateDataKey(true));
    const wrappedKey = await wrapDataKey(raw, passcode, kdf);
    const key = await importRawKey(raw, false);
    raw.fill(0);
    // Record first (with `migrating`), then encrypt: if the app dies half-way, the next start
    // is locked and unlock() finishes the job.
    await this.putLockRow({ ...this.lockRow, failures: 0, lockedUntil: 0, kdf, wrappedKey, migrating: 'encrypt' });
    this.lockDamaged = false;
    this.atRest.key = key;
    this.atRest.encryptWrites = true;
    this.lockStore.set('unlocked');
    await rewriteAll(this.db);
    await this.putLockRow({ ...this.lockRow, migrating: undefined });
  }

  private async disableLock(passcode: string): Promise<void> {
    if (this.isLocked()) throw new Error('locked');
    if (this.lockStore.get() === 'disabled') return;
    (await this.verifyPasscode(passcode)).fill(0);
    await this.putLockRow({ ...this.lockRow, migrating: 'decrypt' });
    await this.finishDisable();
  }

  /** Decrypt every row back (reads still decrypt; writes are now plaintext), then drop the record. */
  private async finishDisable(): Promise<void> {
    this.atRest.encryptWrites = false;
    await rewriteAll(this.db);
    await this.putLockRow({ key: 'lock', autoLockMinutes: this.lockRow.autoLockMinutes, failures: 0, lockedUntil: 0 });
    this.atRest.key = null;
    this.lockStore.set('disabled');
    this.updateRetry();
  }

  private async changePasscode(oldPasscode: string, newPasscode: string): Promise<void> {
    if (isWeakPasscode(newPasscode)) throw new Error('weak-passcode');
    if (this.isLocked()) throw new Error('locked');
    if (this.lockStore.get() === 'disabled') throw new Error('not-enabled');
    const raw = await this.verifyPasscode(oldPasscode);
    try {
      // Same data key, new wrapping: nothing is re-encrypted.
      const kdf = newKdfParams(this.kdfIterations);
      const wrappedKey = await wrapDataKey(raw, newPasscode, kdf);
      await this.putLockRow({ ...this.lockRow, kdf, wrappedKey });
    } finally {
      raw.fill(0);
    }
  }

  private async unlock(passcode: string): Promise<void> {
    if (!this.isLocked()) return;
    const raw = await this.verifyPasscode(passcode);
    const key = await importRawKey(raw, false);
    raw.fill(0);
    this.atRest.key = key;
    const migrating = this.lockRow.migrating;
    let disabled = false;
    try {
      if (migrating === 'decrypt') {
        // disable() was interrupted: finish it. The app ends up without a passcode, as asked.
        await this.finishDisable();
        disabled = true;
      } else if (migrating === 'encrypt') {
        // enable() was interrupted: encrypt the rows it didn't get to.
        await rewriteAll(this.db);
        await this.putLockRow({ ...this.lockRow, migrating: undefined });
      }
    } catch (err) {
      // Rows in either form stay readable; the flag is still set, so the next unlock retries.
      console.error('[lock] could not finish re-writing rows; will retry on the next unlock', err);
      this.atRest.key = key;
      this.atRest.encryptWrites = true;
    }
    await this.loadState();
    this.memes.bump();
    if (!disabled) this.lockStore.set('unlocked');
    if (this.row?.secret) await this.restartTransport();
  }

  /** Stop syncing, forget everything decrypted, and drop the key. */
  private lockNow(): void {
    if (this.lockStore.get() !== 'unlocked') return;
    this.lockStore.set('locked');
    this.clearAutoLockTimer();
    this.detachTransport();
    this.setPartnerTyping(false);
    this.clearTypingTimer();
    this.memes.revokeAll();
    this.memes.bump();
    this.view.reset();
    this.view.publish();
    this.unreadStore.set(0);
    this.row = null;
    this.lastReceivedId = null;
    this.publishProfile();
    this.wantInflight.clear();
    this.typingSent = { active: false, at: 0 };
    this.atRest.key = null;
  }

  private async setAutoLockMinutes(minutes: number): Promise<void> {
    if (!isValidAutoLockMinutes(minutes)) throw new Error('invalid-minutes');
    await this.putLockRow({ ...this.lockRow, autoLockMinutes: minutes });
  }

  private clearAutoLockTimer(): void {
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
  }

  /**
   * Auto-lock. Hidden: remember when, and lock right away (0 min) or after the delay if the page
   * stays alive in the background. Visible again: lock if the delay has passed meanwhile (mobile
   * browsers freeze background timers, so this check is what usually fires).
   */
  private readonly onVisibility = (): void => {
    if (this.disposed || !this.visibility) return;
    const ms = this.autoLockStore.get() * 60_000;
    if (this.visibility.visibilityState === 'hidden') {
      this.hiddenAt = this.now();
      if (this.lockStore.get() !== 'unlocked') return;
      this.clearAutoLockTimer();
      if (ms === 0) void this.lock.lockNow();
      else this.autoLockTimer = setTimeout(() => void this.lock.lockNow(), ms);
    } else {
      this.clearAutoLockTimer();
      const at = this.hiddenAt;
      this.hiddenAt = null;
      if (at !== null && this.lockStore.get() === 'unlocked' && this.now() - at >= ms) void this.lock.lockNow();
    }
  };
}

/** A ULID whose timestamp is more than MAX_FUTURE_SKEW_MS ahead of our clock. */
function isFarFuture(id: string): boolean {
  return ulidTime(id) > Date.now() + MAX_FUTURE_SKEW_MS;
}

function stripUndefined<T extends object>(o: T): T {
  const out = { ...o };
  for (const k of Object.keys(out) as (keyof T)[]) if (out[k] === undefined) delete out[k];
  return out;
}
