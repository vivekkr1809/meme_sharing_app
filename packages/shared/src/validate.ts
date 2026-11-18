import type { MemeMeta, Message } from './domain';
import type { ClientToRelay, ControlFrame, RelayToClient } from './protocol';
import {
  DEVICE_ID_PATTERN,
  MAX_CONTROL_FRAME_CHARS,
  MAX_PEER_STRING_CHARS,
  ROOM_ID_PATTERN,
  isMemeMime,
} from './protocol';
import { ULID_PATTERN } from './ulid';

/** Lightweight runtime validation for untrusted JSON (from the relay or the peer). */

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const optStr = (x: unknown) => x === undefined || typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isEnvelope = (x: unknown) => isObj(x) && isStr(x.payload) && isStr(x.mac);
const HEX64 = /^[0-9a-f]{64}$/;
/** A string of at most `max` UTF-16 code units. */
const shortStr = (x: unknown, max = MAX_PEER_STRING_CHARS): x is string => typeof x === 'string' && x.length <= max;
const optShort = (x: unknown, max = MAX_PEER_STRING_CHARS) => x === undefined || shortStr(x, max);
const isUlid = (x: unknown): x is string => typeof x === 'string' && ULID_PATTERN.test(x);
const nullOrUlid = (x: unknown) => x === null || isUlid(x);
/** Same cap the engine applies to local reactions. */
const MAX_EMOJI_CHARS = 32;
/** Acks are sent one id at a time; leave headroom for batching. */
const MAX_ACK_IDS = 1000;

export function isMessage(x: unknown): x is Message {
  if (!isObj(x)) return false;
  if (!isStr(x.id) || !ULID_PATTERN.test(x.id)) return false;
  if (!isStr(x.authorId) || !x.authorId || x.authorId.length > 64 || !isNum(x.createdAt)) return false;
  if (x.kind !== 'text' && x.kind !== 'meme' && x.kind !== 'reaction') return false;
  if (!optStr(x.text) || !optStr(x.memeId) || !optStr(x.replyTo) || !optShort(x.emoji, MAX_EMOJI_CHARS)) return false;
  if (x.replyTo !== undefined && !isUlid(x.replyTo)) return false;
  if (isStr(x.text) && x.text.length > 10_000) return false;
  if (x.kind === 'meme' && !(isStr(x.memeId) && HEX64.test(x.memeId))) return false;
  if (x.kind === 'reaction' && !(isStr(x.replyTo) && isStr(x.emoji))) return false;
  return true;
}

export function isMemeMeta(x: unknown): x is MemeMeta {
  if (!isObj(x)) return false;
  return (
    isStr(x.id) &&
    HEX64.test(x.id) &&
    isMemeMime(x.mime) &&
    isNum(x.width) &&
    isNum(x.height) &&
    isNum(x.size) &&
    (x.source === 'reddit' || x.source === 'imgflip' || x.source === 'upload' || x.source === 'maker') &&
    optShort(x.sourceUrl) &&
    optShort(x.title)
  );
}

export function parseControlFrame(raw: string | unknown): ControlFrame | null {
  let x: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_CONTROL_FRAME_CHARS) return null;
    try {
      x = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(x)) return null;
  switch (x.type) {
    case 'hello':
      return isNum(x.v) &&
        shortStr(x.deviceId, 64) &&
        shortStr(x.displayName, 256) &&
        nullOrUlid(x.lastReceivedId) &&
        nullOrUlid(x.lastReadId)
        ? (x as ControlFrame)
        : null;
    case 'msg':
      return isMessage(x.message) && (x.meme === undefined || isMemeMeta(x.meme)) ? (x as ControlFrame) : null;
    case 'ack':
      return Array.isArray(x.ids) && x.ids.length <= MAX_ACK_IDS && x.ids.every(isUlid) ? (x as ControlFrame) : null;
    case 'meme-want':
    case 'meme-missing':
      return isStr(x.memeId) && HEX64.test(x.memeId) ? (x as ControlFrame) : null;
    case 'typing':
      return typeof x.active === 'boolean' ? (x as ControlFrame) : null;
    case 'read':
      return isUlid(x.upToId) ? (x as ControlFrame) : null;
    case 'profile':
      return shortStr(x.displayName, 256) ? (x as ControlFrame) : null;
    default:
      return null;
  }
}

export function parseClientToRelay(raw: string): ClientToRelay | null {
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(x)) return null;
  switch (x.type) {
    case 'join':
      return isStr(x.room) && ROOM_ID_PATTERN.test(x.room) && isStr(x.deviceId) && DEVICE_ID_PATTERN.test(x.deviceId)
        ? { type: 'join', room: x.room, deviceId: x.deviceId }
        : null;
    case 'signal':
      return isEnvelope(x.envelope) ? (x as ClientToRelay) : null;
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

export function parseRelayToClient(raw: string): RelayToClient | null {
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(x)) return null;
  switch (x.type) {
    case 'joined':
      return typeof x.peerPresent === 'boolean' ? (x as RelayToClient) : null;
    case 'peer-joined':
    case 'peer-left':
    case 'pong':
      return x as RelayToClient;
    case 'signal':
      return isEnvelope(x.envelope) ? (x as RelayToClient) : null;
    case 'error':
      return isStr(x.code) && isStr(x.message) ? (x as RelayToClient) : null;
    default:
      return null;
  }
}
