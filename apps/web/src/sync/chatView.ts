import Dexie from 'dexie';
import { writable } from '../lib/store';
import type { ChatMessage, DeliveryStatus, ReactionSummary } from '../contracts';
import type { MemesDB, MessageRow } from '../db/schema';

export interface ChatViewContext {
  me(): string;
  /** Partner's read marker over our messages. */
  peerReadId(): string | null;
  /** Our read marker over the partner's messages. */
  myReadId(): string | null;
}

interface ReactionEntry {
  id: string;
  emoji: string;
}

/**
 * The chat window view model.
 *
 * Holds the loaded window of chat rows (sorted by ULID) plus the folded reactions and reply
 * targets it needs, and a cache of built ChatMessage objects. Changes are applied
 * incrementally: `ingest(row)` marks only the affected items dirty, and `publish()` rebuilds
 * just those objects and emits a new array (unchanged items keep their identity, which keeps
 * React re-renders cheap). The DB is only queried when rows enter the window (to fetch their
 * reactions and reply targets).
 *
 * All calls must be serialized by the caller (the engine runs everything on one queue).
 */
export class ChatView {
  readonly messages = writable<ChatMessage[]>([]);

  private rows = new Map<string, MessageRow>();
  private ids: string[] = [];
  /** True when the window reaches the start of history. */
  private complete = false;
  private built = new Map<string, ChatMessage>();
  private dirty = new Set<string>();
  private changed = false;
  /** targetId → authorId → newest reaction by that author. */
  private reactions = new Map<string, Map<string, ReactionEntry>>();
  /** Reply targets that are not in the window. */
  private targets = new Map<string, MessageRow>();
  /** targetId → ids of window items that reply to it. */
  private dependents = new Map<string, Set<string>>();

  constructor(
    private readonly db: () => MemesDB,
    private readonly ctx: ChatViewContext,
    private readonly pageSize: number,
  ) {}

  reset(): void {
    this.rows.clear();
    this.ids = [];
    this.complete = false;
    this.built.clear();
    this.dirty.clear();
    this.reactions.clear();
    this.targets.clear();
    this.dependents.clear();
    this.changed = true;
  }

  async loadLatest(): Promise<void> {
    this.reset();
    const rows = await this.db()
      .messages.where('[lane+id]')
      .between(['c', Dexie.minKey], ['c', Dexie.maxKey], true, true)
      .reverse()
      .limit(this.pageSize)
      .toArray();
    this.complete = rows.length < this.pageSize;
    await this.addRows(rows.reverse());
  }

  async loadOlder(): Promise<boolean> {
    const oldest = this.ids[0];
    if (oldest === undefined) {
      await this.loadLatest();
      return this.ids.length > 0;
    }
    const rows = await this.db()
      .messages.where('[lane+id]')
      .between(['c', Dexie.minKey], ['c', oldest], true, false)
      .reverse()
      .limit(this.pageSize)
      .toArray();
    if (rows.length < this.pageSize) this.complete = true;
    if (rows.length === 0) return false;
    await this.addRows(rows.reverse());
    return true;
  }

  /** A row was inserted or updated in the DB. */
  async ingest(row: MessageRow): Promise<void> {
    if (row.lane === 'r') {
      if (this.applyReaction(row) && row.replyTo && this.rows.has(row.replyTo)) this.dirty.add(row.replyTo);
      return;
    }
    if (this.rows.has(row.id)) {
      this.rows.set(row.id, row);
      this.dirty.add(row.id);
    } else if (this.complete || this.ids.length === 0 || row.id > this.ids[0]!) {
      await this.addRows([row]);
    } else if (this.dependents.has(row.id)) {
      this.targets.set(row.id, row);
    }
    for (const d of this.dependents.get(row.id) ?? []) this.dirty.add(d);
  }

  invalidateAll(): void {
    for (const id of this.ids) this.dirty.add(id);
  }

  /** Newest partner-authored item in the window. */
  newestPartnerId(): string | null {
    const me = this.ctx.me();
    for (let i = this.ids.length - 1; i >= 0; i--) {
      const id = this.ids[i]!;
      if (this.rows.get(id)!.authorId !== me) return id;
    }
    return null;
  }

  publish(): void {
    if (!this.changed && this.dirty.size === 0) return;
    const out: ChatMessage[] = [];
    for (const id of this.ids) {
      let c = this.built.get(id);
      if (!c || this.dirty.has(id)) {
        c = this.build(this.rows.get(id)!);
        this.built.set(id, c);
      }
      out.push(c);
    }
    this.dirty.clear();
    this.changed = false;
    this.messages.set(out);
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private async addRows(rows: MessageRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      if (!this.rows.has(r.id)) insertSorted(this.ids, r.id);
      this.rows.set(r.id, r);
      this.targets.delete(r.id);
      this.dirty.add(r.id);
    }
    this.changed = true;
    const db = this.db();
    const ids = rows.map((r) => r.id);
    const reacts = await db.messages
      .where('[lane+replyTo]')
      .anyOf(ids.map((id) => ['r', id]))
      .toArray();
    for (const r of reacts) this.applyReaction(r);
    const need = [
      ...new Set(
        rows.map((r) => r.replyTo).filter((t): t is string => !!t && !this.rows.has(t) && !this.targets.has(t)),
      ),
    ];
    if (need.length) {
      for (const t of await db.messages.bulkGet(need)) if (t) this.targets.set(t.id, t);
    }
  }

  /** Returns true if the folded state for the target changed. */
  private applyReaction(r: MessageRow): boolean {
    if (!r.replyTo) return false;
    let byAuthor = this.reactions.get(r.replyTo);
    if (!byAuthor) this.reactions.set(r.replyTo, (byAuthor = new Map()));
    const cur = byAuthor.get(r.authorId);
    if (cur && cur.id >= r.id) return false;
    byAuthor.set(r.authorId, { id: r.id, emoji: r.emoji ?? '' });
    return true;
  }

  private build(row: MessageRow): ChatMessage {
    const me = this.ctx.me();
    const mine = row.authorId === me;
    let status: DeliveryStatus;
    if (mine) {
      const peerRead = this.ctx.peerReadId();
      status = peerRead && row.id <= peerRead ? 'read' : row.deliveredAt ? 'delivered' : 'pending';
    } else {
      const myRead = this.ctx.myReadId();
      status = myRead && row.id <= myRead ? 'read' : 'delivered';
    }
    const msg: ChatMessage = {
      id: row.id,
      authorId: row.authorId,
      kind: row.kind as 'text' | 'meme',
      createdAt: row.createdAt,
      mine,
      status,
      reactions: this.summarize(row.id, me),
    };
    if (row.text !== undefined) msg.text = row.text;
    if (row.memeId !== undefined) msg.memeId = row.memeId;
    if (row.replyTo !== undefined) {
      msg.replyTo = row.replyTo;
      let deps = this.dependents.get(row.replyTo);
      if (!deps) this.dependents.set(row.replyTo, (deps = new Set()));
      deps.add(row.id);
      const t = this.rows.get(row.replyTo) ?? this.targets.get(row.replyTo);
      if (t && t.lane === 'c') {
        const preview: NonNullable<ChatMessage['replyPreview']> = {
          id: t.id,
          kind: t.kind as 'text' | 'meme',
          mine: t.authorId === me,
        };
        if (t.text !== undefined) preview.text = t.text;
        if (t.memeId !== undefined) preview.memeId = t.memeId;
        msg.replyPreview = preview;
      }
    }
    return msg;
  }

  private summarize(targetId: string, me: string): ReactionSummary[] {
    const byAuthor = this.reactions.get(targetId);
    if (!byAuthor) return [];
    const entries = [...byAuthor.entries()].filter(([, e]) => e.emoji !== '').sort((a, b) => (a[1].id < b[1].id ? -1 : 1));
    const out: ReactionSummary[] = [];
    for (const [author, e] of entries) {
      let s = out.find((x) => x.emoji === e.emoji);
      if (!s) out.push((s = { emoji: e.emoji, count: 0, mine: false }));
      s.count++;
      if (author === me) s.mine = true;
    }
    return out;
  }
}

function insertSorted(arr: string[], id: string): void {
  let lo = 0;
  let hi = arr.length;
  if (hi === 0 || arr[hi - 1]! < id) {
    arr.push(id);
    return;
  }
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < id) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, id);
}
