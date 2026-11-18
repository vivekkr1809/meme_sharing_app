import type { MemeMeta, Message } from './domain';

export const PROTOCOL_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Relay (signaling) protocol: JSON text frames over WebSocket at RELAY_WS_PATH.
//
// The relay is stateless and content-blind. It only knows an opaque room id
// (derived from the pairing secret, which it never sees) and forwards signed
// envelopes between the (max) two sockets in a room. It never persists anything.
//
// Negotiation rule (who makes the WebRTC offer):
//   - A client that receives `peer-joined` (it was in the room first) creates the offer.
//   - A client whose `joined` says peerPresent=true waits for the offer.
//   - On `peer-left`, close the RTCPeerConnection and wait for the next `peer-joined`.
// ─────────────────────────────────────────────────────────────────────────────

export const RELAY_WS_PATH = '/ws';
export const DEFAULT_RELAY_PORT = 8787;
/** Max size of any single WS text frame accepted by the relay. */
export const MAX_SIGNAL_BYTES = 64 * 1024;
/** Room ids are 16 bytes of HKDF output, hex encoded. */
export const ROOM_ID_PATTERN = /^[0-9a-f]{32}$/;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** Heartbeat: clients send `ping` this often; relay drops sockets silent for 3x this. */
export const HEARTBEAT_MS = 15_000;

export type ClientToRelay =
  /** Join a room. If the same deviceId is already in the room, the old socket is replaced. */
  | { type: 'join'; room: string; deviceId: string }
  /** Forwarded verbatim to the other socket in the room. */
  | { type: 'signal'; envelope: SignedEnvelope }
  | { type: 'ping' };

export type RelayErrorCode = 'bad-request' | 'room-full' | 'not-joined' | 'rate-limited' | 'too-large';

export type RelayToClient =
  | { type: 'joined'; peerPresent: boolean }
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'signal'; envelope: SignedEnvelope }
  | { type: 'pong' }
  | { type: 'error'; code: RelayErrorCode; message: string };

/**
 * A signaling message authenticated with the pairing auth key.
 * `payload` is the JSON string of a SignalPayload; `mac` is base64url HMAC-SHA256(authKey, payload).
 * Signing the exact string avoids any JSON canonicalization issues.
 */
export interface SignedEnvelope {
  payload: string;
  mac: string;
}

export interface SignalPayload {
  v: 1;
  /** Sender deviceId. */
  from: string;
  /** Random hex; receivers reject nonces they've already seen (replay protection). */
  nonce: string;
  /** Sender clock, epoch ms; receivers reject if skew > SIGNAL_MAX_SKEW_MS. */
  ts: number;
  data: SignalData;
}

export const SIGNAL_MAX_SKEW_MS = 5 * 60_000;

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalData =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: IceCandidate };

// ─────────────────────────────────────────────────────────────────────────────
// Relay HTTP endpoints (stateless pass-through, no caching, CORS enabled):
//   GET /health                                  -> { ok: true }
//   GET /proxy/reddit/r/:sub/:sort.json?after=&limit=   sort ∈ hot|new|top|rising
//   GET /proxy/imgflip/get_memes
//   GET /proxy/image?url=<encoded>               host must be in PROXY_IMAGE_HOSTS
// ─────────────────────────────────────────────────────────────────────────────

export const PROXY_IMAGE_HOSTS = [
  'i.redd.it',
  'preview.redd.it',
  'external-preview.redd.it',
  'i.imgur.com',
  'i.imgflip.com',
] as const;
export const PROXY_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const REDDIT_SORTS = ['hot', 'new', 'top', 'rising'] as const;
export type RedditSort = (typeof REDDIT_SORTS)[number];
export const SUBREDDIT_PATTERN = /^[A-Za-z0-9_]{2,32}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Peer protocol: ControlFrames are JSON text messages on the WebRTC DataChannel.
// Binary meme transfer is handled inside the Transport (chunked), surfaced as
// Transport 'blob' events. The receiver MUST verify sha256Hex(data) === memeId.
//
// Sync rules (implemented by the sync engine):
//   1. On connect, each side sends `hello` with the id of the newest message
//      it has received FROM the partner (lastReceivedId) and its read marker.
//   2. On `hello`, send every own message with id > peer.lastReceivedId (ULID
//      string comparison), oldest first, as `msg` frames. This also flushes the outbox.
//   3. On `msg`: store (idempotent upsert), reply `ack`. If it references a memeId
//      we don't have, send `meme-want`.
//   4. On `meme-want`: transport.sendBlob(...) if we have it, else `meme-missing`.
//   5. On `ack`: mark delivered + remove from outbox.
//   6. `read` marks own messages with id <= upToId as read.
// ─────────────────────────────────────────────────────────────────────────────

export type ControlFrame =
  | {
      type: 'hello';
      v: number;
      deviceId: string;
      displayName: string;
      lastReceivedId: string | null;
      lastReadId: string | null;
    }
  | { type: 'msg'; message: Message; meme?: MemeMeta }
  | { type: 'ack'; ids: string[] }
  | { type: 'meme-want'; memeId: string }
  | { type: 'meme-missing'; memeId: string }
  | { type: 'typing'; active: boolean }
  | { type: 'read'; upToId: string }
  | { type: 'profile'; displayName: string };

export type ControlFrameType = ControlFrame['type'];

/** Max bytes of a binary chunk on the DataChannel (safe across browsers). */
export const BLOB_CHUNK_BYTES = 16 * 1024;
/** Max meme size accepted over P2P. */
export const MAX_MEME_BYTES = 15 * 1024 * 1024;

/**
 * The only image types a meme may be stored, sent or displayed as. Raster formats only:
 * SVG (and anything else that can carry script) must never become a `blob:` URL on the
 * app's origin, where opening it in a tab would run it with access to IndexedDB.
 */
export const MEME_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'] as const;
export function isMemeMime(mime: unknown): mime is (typeof MEME_MIME_TYPES)[number] {
  return typeof mime === 'string' && (MEME_MIME_TYPES as readonly string[]).includes(mime);
}

/** Max length (UTF-16 code units) of a JSON control frame accepted from the peer. */
export const MAX_CONTROL_FRAME_CHARS = 256 * 1024;
/** Max length of free-form strings in peer frames (titles, names, URLs). */
export const MAX_PEER_STRING_CHARS = 2048;
/**
 * How far in the future (by its ULID timestamp) a partner's message or read marker may be.
 * Anything later would permanently sort last and pin the sync / read watermarks.
 */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60_000;
