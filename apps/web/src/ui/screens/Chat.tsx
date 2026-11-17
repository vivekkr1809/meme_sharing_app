import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ChatMessage } from '../../contracts';
import { useConnection, useMessages, usePartnerName, usePartnerTyping, useProfile, useServices } from '../context';
import { friendlyError } from '../errors';
import { dayLabel, formatTime, startOfDay } from '../format';
import { Icon } from '../components/Icon';
import { MemeImage, MemeViewer } from '../components/Meme';
import { useToast } from '../components/Toast';
import { importAndSend, useNavigate } from '../nav';

export const REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👍'] as const;
const GROUP_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 140;

type Item =
  | { type: 'day'; key: string; label: string }
  | { type: 'msg'; key: string; m: ChatMessage; first: boolean; last: boolean };

function buildItems(messages: ChatMessage[]): Item[] {
  const out: Item[] = [];
  let prevDay = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const day = startOfDay(m.createdAt);
    if (day !== prevDay) {
      out.push({ type: 'day', key: `day-${day}`, label: dayLabel(m.createdAt) });
      prevDay = day;
    }
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const joins = (a?: ChatMessage, b?: ChatMessage) =>
      !!a && !!b && a.authorId === b.authorId && Math.abs(b.createdAt - a.createdAt) < GROUP_MS && startOfDay(a.createdAt) === startOfDay(b.createdAt);
    out.push({ type: 'msg', key: m.id, m, first: !joins(prev, m), last: !joins(m, next) });
  }
  return out;
}

export function Chat({ active }: { active: boolean }) {
  const services = useServices();
  const { chat } = services;
  const messages = useMessages();
  const typing = usePartnerTyping();
  const connection = useConnection();
  const partner = usePartnerName();
  const toast = useToast();
  const navigate = useNavigate();

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJump, setShowJump] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const loadingRef = useRef(false);
  const hasMore = useRef(true);
  const lastId = useRef<string | undefined>(undefined);
  const firstId = useRef<string | undefined>(undefined);
  const anchor = useRef<{ id: string; offset: number } | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    nearBottom.current = true;
    setShowJump(false);
  }, []);

  const recordAnchor = useCallback(() => {
    const el = listRef.current;
    const id = firstId.current;
    if (!el || !id) return;
    const node = el.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (node) anchor.current = { id, offset: node.offsetTop - el.scrollTop };
  }, []);

  const maybeMarkRead = useCallback(() => {
    if (!active || document.visibilityState !== 'visible' || !nearBottom.current) return;
    if (chat.unreadCount.get() > 0) chat.markRead();
  }, [active, chat]);

  // Keep scroll position sensible as messages change.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const newest = messages[messages.length - 1];
    const oldest = messages[0];
    const prevFirst = firstId.current;
    const prevLast = lastId.current;
    firstId.current = oldest?.id;
    lastId.current = newest?.id;

    if (prevFirst && oldest && oldest.id !== prevFirst && anchor.current?.id === prevFirst) {
      // Older messages were prepended: keep the previous first message where it was.
      const node = el.querySelector<HTMLElement>(`[data-id="${prevFirst}"]`);
      if (node) el.scrollTop = node.offsetTop - anchor.current.offset;
    }
    if (newest && newest.id !== prevLast) {
      if (prevLast === undefined || nearBottom.current || newest.mine) scrollToBottom();
      else if (!newest.mine) setShowJump(true);
    }
    recordAnchor();
  }, [messages, scrollToBottom, recordAnchor]);

  // Stick to the bottom while content grows (images arriving, typing indicator).
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (active && nearBottom.current) scrollToBottom();
  }, [active, scrollToBottom]);

  useEffect(() => {
    if (typing && nearBottom.current) scrollToBottom();
  }, [typing, scrollToBottom]);

  // Mark as read while visible.
  useEffect(() => {
    maybeMarkRead();
    const on = () => maybeMarkRead();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [maybeMarkRead, messages]);

  const loadOlder = useCallback(async () => {
    if (loadingRef.current || !hasMore.current) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    recordAnchor();
    try {
      hasMore.current = await chat.loadOlder();
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't load older messages."));
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [chat, toast, recordAnchor]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom.current) {
      setShowJump(false);
      maybeMarkRead();
    }
    if (el.scrollTop < 120 && el.scrollHeight > el.clientHeight) void loadOlder();
    recordAnchor();
  };

  const react = useCallback(
    (id: string, emoji: string) => {
      setMenuFor(null);
      chat.react(id, emoji).catch((e) => toast.error(friendlyError(e)));
    },
    [chat, toast],
  );
  const reply = useCallback((m: ChatMessage) => {
    setMenuFor(null);
    setReplyTo(m);
    requestAnimationFrame(() => document.getElementById('composer-input')?.focus());
  }, []);
  const jumpTo = useCallback((id: string) => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  }, []);

  // Keep the selected message visible above the reaction tray.
  useEffect(() => {
    if (!menuFor) return;
    const raf = requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-id="${menuFor}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }),
    );
    return () => cancelAnimationFrame(raf);
  }, [menuFor]);

  const menuMsg = menuFor ? messages.find((m) => m.id === menuFor) : undefined;
  const items = buildItems(messages);

  return (
    <section className="screen chat" aria-label="Chat">
      <ChatHeader />
      {connection !== 'connected' && <ConnectionBanner />}
      <div className="chat-scroll" ref={listRef} onScroll={onScroll}>
        <div className={`chat-inner ${menuMsg ? 'with-tray' : ''}`} ref={innerRef}>
          {loadingOlder && (
            <div className="older-loading" role="status">
              <span className="spinner" /> Loading older messages…
            </div>
          )}
          {messages.length === 0 ? (
            <div className="chat-empty">
              <div className="empty-emoji" aria-hidden="true">
                👋
              </div>
              <h3>Say hi to {partner}</h3>
              <p>Send a message, or find the perfect meme to start things off.</p>
              <button type="button" className="btn btn-soft" onClick={() => navigate('discover')}>
                <Icon name="compass" size={18} /> Find a meme
              </button>
            </div>
          ) : (
            <ol className="msg-list" aria-label="Messages">
              {items.map((it) =>
                it.type === 'day' ? (
                  <li key={it.key} className="day-sep" role="separator" aria-label={it.label}>
                    <span>{it.label}</span>
                  </li>
                ) : (
                  <Bubble
                    key={it.key}
                    m={it.m}
                    first={it.first}
                    last={it.last}
                    selected={menuFor === it.m.id}
                    partner={partner}
                    onMenu={setMenuFor}
                    onReact={react}
                    onReply={reply}
                    onOpenMeme={setViewer}
                    onJumpTo={jumpTo}
                  />
                ),
              )}
            </ol>
          )}
          {typing && (
            <div className="typing" role="status" aria-label={`${partner} is typing`}>
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </div>

      {showJump && (
        <button type="button" className="jump-pill" onClick={scrollToBottom}>
          ↓ New message
        </button>
      )}

      {menuMsg && <ReactionTray m={menuMsg} onReact={react} onReply={reply} onClose={() => setMenuFor(null)} />}

      <Composer replyTo={replyTo} onClearReply={() => setReplyTo(null)} partner={partner} />

      {viewer && <MemeViewer memeId={viewer} onClose={() => setViewer(null)} actions={{ favorite: true }} />}
    </section>
  );
}

function ChatHeader() {
  const profile = useProfile();
  const connection = useConnection();
  const typing = usePartnerTyping();
  const name = profile?.partnerName ?? 'Your partner';
  const status = typing ? 'typing…' : connection === 'connected' ? 'online' : connection === 'connecting' ? 'connecting…' : 'offline';
  return (
    <header className="topbar chat-top">
      <div className={`avatar status-${connection}`} aria-hidden="true">
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="topbar-text">
        <h1 className="topbar-title">{name}</h1>
        <p className={`topbar-sub ${typing ? 'is-typing' : ''}`} aria-live="polite">
          {status}
        </p>
      </div>
    </header>
  );
}

export function ConnectionBanner() {
  const connection = useConnection();
  const partner = usePartnerName();
  const [label, cls] =
    connection === 'waiting'
      ? [`${partner[0]!.toUpperCase() + partner.slice(1)} is offline. Messages will be delivered when they open the app.`, 'banner-waiting']
      : connection === 'connecting'
        ? ['Connecting…', 'banner-connecting']
        : ['Not connected. Messages are saved and will send later.', 'banner-idle'];
  return (
    <div className={`banner ${cls}`} role="status">
      {connection === 'connecting' ? <span className="spinner sm" aria-hidden="true" /> : <Icon name="wifiOff" size={16} />}
      <span>{label}</span>
    </div>
  );
}

const STATUS_LABEL = { pending: 'Sending', delivered: 'Delivered', read: 'Read' } as const;
const STATUS_GLYPH = { pending: '🕓', delivered: '✓', read: '✓✓' } as const;

interface BubbleProps {
  m: ChatMessage;
  first: boolean;
  last: boolean;
  selected: boolean;
  partner: string;
  onMenu: (id: string | null) => void;
  onReact: (id: string, emoji: string) => void;
  onReply: (m: ChatMessage) => void;
  onOpenMeme: (memeId: string) => void;
  onJumpTo: (id: string) => void;
}

const Bubble = memo(function Bubble({ m, first, last, selected, partner, onMenu, onReact, onReply, onOpenMeme, onJumpTo }: BubbleProps) {
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longPressed = useRef(false);

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressed.current = false;
    cancelPress();
    press.current = {
      x: e.clientX,
      y: e.clientY,
      t: setTimeout(() => {
        longPressed.current = true;
        navigator.vibrate?.(10);
        onMenu(m.id);
      }, 450),
    };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) cancelPress();
  };

  const time = formatTime(m.createdAt);
  const isMeme = m.kind === 'meme' && !!m.memeId;
  const who = m.mine ? 'You' : partner;

  return (
    <li
      data-id={m.id}
      className={`msg ${m.mine ? 'mine' : 'theirs'} ${first ? 'g-first' : ''} ${last ? 'g-last' : ''} ${selected ? 'selected' : ''} ${isMeme ? 'is-meme' : ''}`}
    >
      <div className="msg-row">
        <div
          className="bubble"
          onPointerDown={onPointerDown}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onPointerCancel={cancelPress}
          onPointerMove={onPointerMove}
          onContextMenu={(e) => {
            e.preventDefault();
            cancelPress();
            onMenu(m.id);
          }}
          aria-label={`${who} at ${time}`}
        >
          {m.replyPreview && (
            <button
              type="button"
              className="quote"
              onClick={() => onJumpTo(m.replyPreview!.id)}
              aria-label={`Reply to ${m.replyPreview.mine ? 'you' : partner}: ${m.replyPreview.text ?? 'a meme'}`}
            >
              <span className="quote-name">{m.replyPreview.mine ? 'You' : partner}</span>
              <span className="quote-body">
                {m.replyPreview.memeId && (
                  <span className="quote-thumb">
                    <MemeImage memeId={m.replyPreview.memeId} fit="cover" alt="" />
                  </span>
                )}
                <span className="quote-text">{m.replyPreview.text || (m.replyPreview.kind === 'meme' ? 'Meme' : '')}</span>
              </span>
            </button>
          )}
          {isMeme && (
            <button
              type="button"
              className="meme-btn"
              onClick={() => {
                if (longPressed.current) return;
                onOpenMeme(m.memeId!);
              }}
              aria-label="Open meme fullscreen"
            >
              <MemeImage memeId={m.memeId!} />
            </button>
          )}
          {m.text && <p className="msg-text">{m.text}</p>}
          <span className="msg-meta">
            <time dateTime={new Date(m.createdAt).toISOString()}>{time}</time>
            {m.mine && (
              <span className={`tick tick-${m.status}`} aria-label={STATUS_LABEL[m.status]} title={STATUS_LABEL[m.status]}>
                {STATUS_GLYPH[m.status]}
              </span>
            )}
          </span>
        </div>
        <div className="bubble-tools">
          <button type="button" className="tool-btn" aria-label="React" onClick={() => onMenu(m.id)}>
            <Icon name="smile" size={18} />
          </button>
          <button type="button" className="tool-btn" aria-label="Reply" onClick={() => onReply(m)}>
            <Icon name="reply" size={18} />
          </button>
        </div>
      </div>
      {m.reactions.length > 0 && (
        <div className="reactions" aria-label="Reactions">
          {m.reactions.map((r) => (
            <button
              type="button"
              key={r.emoji}
              className={`reaction ${r.mine ? 'mine' : ''}`}
              aria-pressed={r.mine}
              aria-label={`${r.emoji} ${r.count}${r.mine ? ', including you' : ''}`}
              onClick={() => onReact(m.id, r.emoji)}
            >
              <span aria-hidden="true">{r.emoji}</span>
              {r.count > 1 && <span className="reaction-count">{r.count}</span>}
            </button>
          ))}
        </div>
      )}
    </li>
  );
});

function ReactionTray({ m, onReact, onReply, onClose }: { m: ChatMessage; onReact: (id: string, e: string) => void; onReply: (m: ChatMessage) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const mine = m.reactions.find((r) => r.mine)?.emoji;

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ((t as Element).closest?.(`[data-id="${m.id}"]`)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [m.id, onClose]);

  return (
    <div className="tray" ref={ref} role="toolbar" aria-label="Message actions">
      <div className="tray-emojis">
        {REACTIONS.map((e) => (
          <button type="button" key={e} className={`tray-emoji ${mine === e ? 'is-on' : ''}`} aria-label={`React with ${e}`} aria-pressed={mine === e} onClick={() => onReact(m.id, e)}>
            {e}
          </button>
        ))}
      </div>
      <div className="tray-actions">
        <button type="button" className="tray-btn" onClick={() => onReply(m)}>
          <Icon name="reply" size={18} /> Reply
        </button>
        {m.text && (
          <button
            type="button"
            className="tray-btn"
            onClick={() => {
              navigator.clipboard?.writeText(m.text!).then(
                () => toast.success('Copied'),
                () => toast.error("Couldn't copy"),
              );
              onClose();
            }}
          >
            <Icon name="copy" size={18} /> Copy
          </button>
        )}
        <button type="button" className="tray-btn icon-only" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}

function Composer({ replyTo, onClearReply, partner }: { replyTo: ChatMessage | null; onClearReply: () => void; partner: string }) {
  const services = useServices();
  const { chat, images } = services;
  const toast = useToast();
  const [text, setText] = useState('');
  const [attaching, setAttaching] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const typingOn = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTyping = useCallback(() => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    if (typingOn.current) {
      typingOn.current = false;
      chat.setTyping(false);
    }
  }, [chat]);

  useEffect(() => stopTyping, [stopTyping]);

  // Auto-grow the textarea up to ~5 lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }, [text]);

  const onChange = (v: string) => {
    setText(v);
    if (!v.trim()) return stopTyping();
    if (!typingOn.current) {
      typingOn.current = true;
      chat.setTyping(true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 3000);
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    const r = replyTo?.id;
    setText('');
    stopTyping();
    onClearReply();
    try {
      await chat.sendText(t, r);
    } catch (e) {
      setText(t);
      toast.error(friendlyError(e, "Couldn't send that message."));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setAttaching(true);
    const r = replyTo?.id;
    try {
      const processed = await images.processUpload(f);
      await importAndSend(services, { ...processed, source: 'upload', title: f.name.replace(/\.[a-z0-9]+$/i, '') || undefined }, r);
      onClearReply();
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't send that image."));
    } finally {
      setAttaching(false);
      if (file.current) file.current.value = '';
    }
  };

  return (
    <div className="composer-wrap">
      {replyTo && (
        <div className="reply-bar">
          <Icon name="reply" size={16} />
          <div className="reply-bar-text">
            <span className="quote-name">Replying to {replyTo.mine ? 'yourself' : partner}</span>
            <span className="quote-text">{replyTo.text || 'Meme'}</span>
          </div>
          <button type="button" className="icon-btn sm" aria-label="Cancel reply" onClick={onClearReply}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <button type="button" className="icon-btn attach" aria-label="Attach an image" onClick={() => file.current?.click()} disabled={attaching}>
          {attaching ? <span className="spinner sm" aria-hidden="true" /> : <Icon name="plus" />}
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} aria-hidden="true" tabIndex={-1} />
        <textarea
          id="composer-input"
          ref={input}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={`Message ${partner}`}
          aria-label="Message"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={stopTyping}
          enterKeyHint="send"
        />
        <button type="submit" className="send-btn" aria-label="Send" disabled={!text.trim()}>
          <Icon name="send" size={20} />
        </button>
      </form>
    </div>
  );
}
