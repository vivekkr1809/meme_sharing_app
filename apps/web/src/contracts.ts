/**
 * ════════════════════════════════════════════════════════════════════════════
 *  MODULE CONTRACTS — the interfaces every module codes against.
 *  Owned by the lead. Do NOT change signatures without coordinating.
 *
 *   ┌──────────── UI (src/ui) ─────────────┐   consumes AppServices only
 *   └──────────────────┬───────────────────┘
 *        AppServices = DataServices (src/db + src/sync)  +  MemeServices (src/memes)
 *                           │
 *                       Transport (src/p2p)  ← WebRTC + relay signaling
 * ════════════════════════════════════════════════════════════════════════════
 */
import type { ConnectionState, ControlFrame, MemeMeta, MemeSourceKind, Message, PairingKeys } from '@memes/shared';
import type { Readable } from './lib/store';

export type { Readable } from './lib/store';
export type Unsubscribe = () => void;

// ─── Transport (implemented in src/p2p) ─────────────────────────────────────

export interface TransportEvents {
  state: ConnectionState;
  /** A validated control frame from the partner. */
  frame: ControlFrame;
  /** A fully reassembled binary meme. Receiver must verify sha256Hex(data) === memeId. */
  blob: { memeId: string; mime: string; data: Uint8Array };
}

export interface Transport {
  readonly state: ConnectionState;
  /** Connect to the relay, negotiate WebRTC, and keep reconnecting (with backoff) until stop(). */
  start(): void;
  /** Close everything; state becomes 'idle'. start() may be called again later. */
  stop(): void;
  /** Send a control frame. Returns false (and drops it) if not connected. */
  send(frame: ControlFrame): boolean;
  /** Chunk and send a binary blob. Rejects if the connection drops mid-transfer. */
  sendBlob(memeId: string, mime: string, data: Uint8Array): Promise<void>;
  on<K extends keyof TransportEvents>(event: K, cb: (payload: TransportEvents[K]) => void): Unsubscribe;
}

export interface TransportOptions {
  /** Relay base URL, e.g. "https://relay.example.com" or "http://localhost:8787". */
  relayUrl: string;
  keys: PairingKeys;
  deviceId: string;
  iceServers?: RTCIceServer[];
  /** Injection points for tests. Default to the globals. */
  WebSocketImpl?: typeof WebSocket;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
}

export type CreateTransport = (opts: TransportOptions) => Transport;

// ─── Data services (implemented in src/db + src/sync) ───────────────────────

export interface Profile {
  deviceId: string;
  displayName: string;
  /** True once a pairing secret exists on this device (created or accepted). */
  paired: boolean;
  /** Human-readable pairing code (also encoded in the QR). Present while paired. */
  pairingCode?: string;
  /** Learned from the partner's `hello`; absent until first connection. */
  partnerName?: string;
  partnerDeviceId?: string;
  createdAt: number;
}

export interface PairingService {
  /** null until onboarding (setDisplayName) has happened. */
  profile: Readable<Profile | null>;
  /** Creates the profile on first call; later calls rename (and notify partner). */
  setDisplayName(name: string): Promise<void>;
  /** Generate a new secret, start connecting, return the pairing code to show as QR/text. */
  createPairing(): Promise<string>;
  /** Accept a code from the partner (scanned or typed). Throws Error('invalid-code') if malformed. */
  acceptPairing(code: string): Promise<void>;
  /** Forget the pairing secret and disconnect. Keeps history. */
  unpair(): Promise<void>;
  /** Delete ALL local data (messages, memes, profile, settings). */
  wipe(): Promise<void>;
}

export type DeliveryStatus = 'pending' | 'delivered' | 'read';

export interface ReactionSummary {
  emoji: string;
  /** Number of people (0-2) who reacted with this emoji. */
  count: number;
  mine: boolean;
}

/** A displayable chat item (reaction messages are folded into `reactions`, never listed). */
export interface ChatMessage extends Message {
  kind: 'text' | 'meme';
  mine: boolean;
  /** Only meaningful when mine === true. */
  status: DeliveryStatus;
  reactions: ReactionSummary[];
  /** The message this replies to, if loaded. */
  replyPreview?: { id: string; kind: 'text' | 'meme'; text?: string; memeId?: string; mine: boolean };
}

export interface ChatService {
  connection: Readable<ConnectionState>;
  partnerTyping: Readable<boolean>;
  /** Loaded window of the conversation, oldest → newest. Starts with the latest ~50. */
  messages: Readable<ChatMessage[]>;
  /** Number of partner messages newer than our read marker. */
  unreadCount: Readable<number>;
  /** Load an older page into `messages`. Resolves false when there is nothing older. */
  loadOlder(): Promise<boolean>;
  sendText(text: string, replyTo?: string): Promise<void>;
  /** The meme must already be in the library (see MemeLibrary.importImage). */
  sendMeme(memeId: string, caption?: string, replyTo?: string): Promise<void>;
  /** Set my reaction on a message; same emoji again (or '') removes it. */
  react(messageId: string, emoji: string): Promise<void>;
  setTyping(active: boolean): void;
  /** Mark everything currently loaded as read (sends `read` to partner). */
  markRead(): void;
}

export interface LibraryMeme extends MemeMeta {
  savedAt: number;
  favorite: boolean;
}

export interface ImportImageInput {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  source: MemeSourceKind;
  sourceUrl?: string;
  title?: string;
}

export interface MemeLibrary {
  /** Hash + store (deduped by content). Returns the stored meta. */
  importImage(input: ImportImageInput): Promise<LibraryMeme>;
  get(memeId: string): Promise<LibraryMeme | undefined>;
  /** Object URL for display (cached per id); null if the image hasn't arrived yet. */
  getUrl(memeId: string): Promise<string | null>;
  list(opts?: { favoritesOnly?: boolean; query?: string; limit?: number }): Promise<LibraryMeme[]>;
  toggleFavorite(memeId: string): Promise<boolean>;
  remove(memeId: string): Promise<void>;
  /** Increments whenever the library changes (new meme received, favorite toggled…). */
  version: Readable<number>;
}

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  /** Relay base URL; '' means "same origin as the app". */
  relayUrl: string;
  subreddits: string[];
  theme: Theme;
  /** Hide posts flagged NSFW / spoiler in Discover. */
  hideNsfw: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  relayUrl: '',
  subreddits: ['memes', 'wholesomememes', 'me_irl', 'dankmemes', 'ProgrammerHumor'],
  theme: 'system',
  hideNsfw: true,
};

export interface SettingsService {
  settings: Readable<Settings>;
  update(patch: Partial<Settings>): Promise<void>;
}

export interface BackupOptions {
  /**
   * Export: encrypt the file with this password (PBKDF2 → AES-GCM, see @memes/shared passcrypto).
   * Import: password for an encrypted file. Ignored for legacy unencrypted files.
   */
  password?: string;
}

export interface BackupService {
  /**
   * A single local file containing messages, memes, profile and settings (never the pairing secret).
   * With `password` the file is encrypted; without it, it is plain JSON (the UI always asks for one).
   */
  exportBackup(opts?: BackupOptions): Promise<Blob>;
  /**
   * Merge a backup into the local DB (idempotent).
   * Throws Error('password-required') if the file is encrypted and no password was given,
   * Error('wrong-password') if it doesn't decrypt, Error('invalid-backup') if malformed.
   */
  importBackup(file: Blob, opts?: BackupOptions): Promise<{ messages: number; memes: number }>;
}

/**
 * disabled - no passcode set; data stored as before
 * locked   - passcode set, data key not in memory: chat/library/pairing are unavailable,
 *            the transport is stopped, and only unlock() / pairing.wipe() work
 * unlocked - passcode set and data key in memory; everything works
 */
export type LockState = 'disabled' | 'locked' | 'unlocked';

export interface LockService {
  state: Readable<LockState>;
  /**
   * Lock after the app has been hidden (backgrounded) this many minutes. 0 = as soon as it is hidden.
   * Default 5. Always locked on a fresh app start when a passcode is set.
   */
  autoLockMinutes: Readable<number>;
  /** ms until another unlock attempt is allowed (grows after repeated failures); 0 = allowed now. */
  retryAfterMs: Readable<number>;
  /** Set a passcode and encrypt local data at rest. Throws Error('weak-passcode') if < 4 chars. */
  enable(passcode: string): Promise<void>;
  /** Remove the passcode and decrypt local data. Throws Error('wrong-passcode'). */
  disable(passcode: string): Promise<void>;
  /** Throws Error('wrong-passcode') | Error('weak-passcode'). */
  change(oldPasscode: string, newPasscode: string): Promise<void>;
  /** Throws Error('wrong-passcode') | Error('too-many-attempts') (wait retryAfterMs). */
  unlock(passcode: string): Promise<void>;
  /** Drop the key from memory and stop syncing. No-op if disabled. */
  lockNow(): Promise<void>;
  setAutoLockMinutes(minutes: number): Promise<void>;
}

export interface DataServices {
  pairing: PairingService;
  chat: ChatService;
  library: MemeLibrary;
  settings: SettingsService;
  backup: BackupService;
  lock: LockService;
  /** Stop transports, close DB. */
  dispose(): Promise<void>;
}

export interface CreateDataServicesOptions {
  /** IndexedDB database name (tests use unique names). Default "memes". */
  dbName?: string;
  createTransport: CreateTransport;
  /** Used when settings.relayUrl is ''. In the browser: location.origin. */
  defaultRelayUrl: string;
  iceServers?: RTCIceServer[];
}

// ─── Meme services (implemented in src/memes) ───────────────────────────────

export interface RedditPost {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  score: number;
  permalink: string;
  /** Direct image URL (jpg/png/gif/webp). Posts without one are filtered out. */
  imageUrl: string;
  /** Smaller preview for the feed grid when available. */
  thumbUrl?: string;
  width?: number;
  height?: number;
  nsfw: boolean;
  createdAt: number;
}

export interface RedditPage {
  posts: RedditPost[];
  /** Cursor for the next page; null at the end. */
  after: string | null;
}

export interface RedditSource {
  fetchPage(subreddit: string, opts?: { sort?: 'hot' | 'new' | 'top' | 'rising'; after?: string | null }): Promise<RedditPage>;
}

export interface MemeTemplate {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  boxCount: number;
}

export interface ImgflipSource {
  listTemplates(): Promise<MemeTemplate[]>;
}

/** Caption box in template-relative coordinates (0..1). */
export interface CaptionBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Default: white Impact-style with black outline, uppercase. */
  color?: string;
  outlineColor?: string;
  uppercase?: boolean;
}

export interface ProcessedImage {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
}

export interface ImageTools {
  /** Download a remote image (direct, falling back to the relay image proxy). */
  fetchImage(url: string): Promise<ProcessedImage>;
  /** Resize (max 1600px), re-encode to WebP/JPEG, strip metadata. GIFs pass through (≤15MB). */
  processUpload(file: Blob): Promise<ProcessedImage>;
  /** Render captions onto the template entirely on-device with <canvas>. */
  renderMeme(template: MemeTemplate, boxes: CaptionBox[]): Promise<ProcessedImage>;
  /** Suggested default caption boxes for a template (top/bottom for 2, stacked for N). */
  defaultBoxes(template: MemeTemplate): CaptionBox[];
}

export interface MemeServices {
  reddit: RedditSource;
  imgflip: ImgflipSource;
  images: ImageTools;
}

export interface CreateMemeServicesOptions {
  /** Returns the current relay base URL (for proxy fallbacks). */
  getRelayUrl: () => string;
  fetchImpl?: typeof fetch;
}

// ─── Everything the UI gets ─────────────────────────────────────────────────

export interface AppServices extends DataServices, MemeServices {}
