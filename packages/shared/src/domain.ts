/**
 * Domain types shared by the web app (and visible in the wire protocol).
 * Everything here is stored ONLY on the two paired devices.
 */

export type MessageKind = 'text' | 'meme' | 'reaction';

export interface Message {
  /** ULID: sortable by creation time, unique across both devices. */
  id: string;
  /** deviceId of the author. */
  authorId: string;
  kind: MessageKind;
  /** Text body (kind 'text') or optional caption (kind 'meme'). */
  text?: string;
  /** Content id (sha256 hex) of the meme image (kind 'meme'). */
  memeId?: string;
  /** For 'text'/'meme': message being replied to. For 'reaction': the target message. */
  replyTo?: string;
  /** Reaction emoji (kind 'reaction'). An empty string removes the author's reaction. */
  emoji?: string;
  /** Epoch ms on the author's device. */
  createdAt: number;
}

export type MemeSourceKind = 'reddit' | 'imgflip' | 'upload' | 'maker';

export interface MemeMeta {
  /** sha256 hex of the image bytes: content-addressed, so identical images dedupe. */
  id: string;
  mime: string;
  width: number;
  height: number;
  /** Bytes. */
  size: number;
  source: MemeSourceKind;
  sourceUrl?: string;
  title?: string;
}

/**
 * idle       - not started / not paired
 * connecting - talking to the relay or negotiating WebRTC
 * waiting    - in the relay room, partner not present
 * connected  - DataChannel open to partner
 */
export type ConnectionState = 'idle' | 'connecting' | 'waiting' | 'connected';
