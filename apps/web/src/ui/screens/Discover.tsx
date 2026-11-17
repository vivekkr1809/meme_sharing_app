import { REDDIT_SORTS, type RedditSort } from '@memes/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { RedditPost } from '../../contracts';
import { usePartnerName, useServices, useSettings } from '../context';
import { friendlyError, isSubredditMissing } from '../errors';
import { formatScore, redditUrl } from '../format';
import { Segmented } from '../components/Controls';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { importAndFavorite, importAndSend, useNavigate } from '../nav';

interface Feed {
  key: string;
  posts: RedditPost[];
  after: string | null;
  loading: boolean;
  error: unknown;
  done: boolean;
}

const SORT_LABELS: Record<RedditSort, string> = { hot: 'Hot', new: 'New', top: 'Top', rising: 'Rising' };

function useColumns(ref: RefObject<HTMLElement | null>): number {
  const [cols, setCols] = useState(2);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const w = e!.contentRect.width;
      setCols(w < 300 ? 1 : w < 620 ? 2 : w < 900 ? 3 : 4);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return cols;
}

export function Discover({ active }: { active: boolean }) {
  const { reddit } = useServices();
  const settings = useSettings();
  const subs = settings.subreddits;
  const [sub, setSub] = useState(subs[0] ?? 'memes');
  const [sort, setSort] = useState<RedditSort>('hot');
  const [open, setOpen] = useState<RedditPost | null>(null);
  const key = `${sub}|${sort}`;
  const [feed, setFeed] = useState<Feed>({ key, posts: [], after: null, loading: false, error: null, done: false });
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const cols = useColumns(scrollRef);

  // Keep the selected sub valid when the list changes in Settings.
  useEffect(() => {
    if (subs.length && !subs.some((s) => s.toLowerCase() === sub.toLowerCase())) setSub(subs[0]!);
  }, [subs, sub]);

  const load = useCallback(
    async (reset: boolean) => {
      const cur = feedRef.current;
      if (!reset && (cur.loading || cur.done || cur.error)) return;
      const after = reset ? null : cur.after;
      setFeed((f) => (reset ? { key, posts: [], after: null, loading: true, error: null, done: false } : { ...f, loading: true }));
      try {
        const page = await reddit.fetchPage(sub, { sort, after });
        setFeed((f) => {
          if (f.key !== key) return f;
          const seen = new Set(f.posts.map((p) => p.id));
          return { ...f, posts: [...f.posts, ...page.posts.filter((p) => !seen.has(p.id))], after: page.after, loading: false, done: page.after === null };
        });
      } catch (error) {
        setFeed((f) => (f.key !== key ? f : { ...f, loading: false, error }));
      }
    },
    [reddit, sub, sort, key],
  );

  // Start (or restart) the feed when the sub/sort changes and the tab is visible.
  useEffect(() => {
    if (!active) return;
    if (feedRef.current.key !== key || (!feedRef.current.posts.length && !feedRef.current.loading && !feedRef.current.error)) void load(true);
  }, [active, key, load]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !active || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void load(false), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [active, load, feed.posts.length]);

  const visible = useMemo(() => (settings.hideNsfw ? feed.posts.filter((p) => !p.nsfw) : feed.posts), [feed.posts, settings.hideNsfw]);

  const columns = useMemo(() => {
    const out: RedditPost[][] = Array.from({ length: cols }, () => []);
    const heights = new Array(cols).fill(0) as number[];
    for (const p of visible) {
      const i = heights.indexOf(Math.min(...heights));
      out[i]!.push(p);
      heights[i]! += (p.height && p.width ? p.height / p.width : 1) + 0.18;
    }
    return out;
  }, [visible, cols]);

  const isStale = feed.key !== key;
  const loading = feed.loading || isStale;
  const notFound = !!feed.error && isSubredditMissing(feed.error);

  return (
    <section className="screen discover" aria-label="Discover">
      <header className="topbar">
        <h1 className="topbar-title big">Discover</h1>
      </header>
      <div className="discover-controls">
        <div className="chips" role="tablist" aria-label="Subreddits">
          {subs.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={s === sub} className={`chip ${s === sub ? 'is-on' : ''}`} onClick={() => setSub(s)}>
              r/{s}
            </button>
          ))}
        </div>
        <Segmented<RedditSort> label="Sort" size="sm" value={sort} onChange={setSort} options={REDDIT_SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))} />
      </div>

      <div className="scroll discover-scroll" ref={scrollRef}>
        {feed.error && !isStale && !feed.posts.length ? (
          <div className="empty">
            <div className="empty-emoji" aria-hidden="true">
              {notFound ? '🕳️' : '📡'}
            </div>
            <h3>{notFound ? `r/${sub} not found` : "Couldn't load memes"}</h3>
            <p>{notFound ? "That subreddit doesn't exist, is private, or was banned. You can edit your list in Settings." : friendlyError(feed.error)}</p>
            {!notFound && (
              <button type="button" className="btn btn-soft" onClick={() => void load(true)}>
                <Icon name="refresh" size={18} /> Try again
              </button>
            )}
          </div>
        ) : !loading && !isStale && feed.done && !visible.length ? (
          <div className="empty">
            <div className="empty-emoji" aria-hidden="true">
              🫥
            </div>
            <h3>Nothing to see here</h3>
            <p>{feed.posts.length ? 'Every post here was hidden by your NSFW filter.' : `r/${sub} has no image posts right now.`}</p>
          </div>
        ) : (
          <div className="masonry" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} aria-busy={loading}>
            {!isStale &&
              columns.map((col, ci) => (
                <div className="masonry-col" key={ci}>
                  {col.map((p) => (
                    <PostTile key={p.id} post={p} onOpen={() => setOpen(p)} />
                  ))}
                </div>
              ))}
            {loading &&
              !visible.length &&
              Array.from({ length: cols }, (_, ci) => (
                <div className="masonry-col" key={`sk${ci}`}>
                  {[1.1, 0.8, 1.3].map((r, i) => (
                    <div key={i} className="skeleton" style={{ aspectRatio: `1 / ${ci % 2 ? 2.1 - r : r}` }} />
                  ))}
                </div>
              ))}
          </div>
        )}
        <div ref={sentinel} className="sentinel" aria-hidden="true" />
        {feed.posts.length > 0 && !isStale && (
          <div className="feed-foot">
            {feed.loading ? (
              <span className="spinner" role="status" aria-label="Loading more" />
            ) : feed.error ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                  feedRef.current = { ...feedRef.current, error: null };
                  void load(false);
                }}>
                Couldn't load more. Retry
              </button>
            ) : feed.done ? (
              <span className="muted">You've reached the end 🎉</span>
            ) : typeof IntersectionObserver === 'undefined' ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load(false)}>
                Load more
              </button>
            ) : null}
          </div>
        )}
      </div>

      {open && <PostSheet post={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function PostTile({ post, onOpen }: { post: RedditPost; onOpen: () => void }) {
  const ratio = post.width && post.height ? post.height / post.width : 1;
  return (
    <button type="button" className="tile" onClick={onOpen} aria-label={post.title}>
      <img src={post.thumbUrl ?? post.imageUrl} alt="" loading="lazy" decoding="async" style={{ aspectRatio: `1 / ${Math.min(ratio, 2)}` }} referrerPolicy="no-referrer" />
      {post.nsfw && <span className="badge badge-nsfw">NSFW</span>}
      <span className="tile-caption">
        <span className="tile-title">{post.title}</span>
        <span className="tile-meta">▲ {formatScore(post.score)}</span>
      </span>
    </button>
  );
}

function PostSheet({ post, onClose }: { post: RedditPost; onClose: () => void }) {
  const services = useServices();
  const partner = usePartnerName();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'send' | 'save' | null>(null);

  const fetchInput = async () => {
    const img = await services.images.fetchImage(post.imageUrl);
    return { ...img, source: 'reddit' as const, sourceUrl: redditUrl(post.permalink), title: post.title };
  };

  const send = async () => {
    setBusy('send');
    try {
      await importAndSend(services, await fetchInput());
      onClose();
      navigate('chat');
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't send that meme."));
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      await importAndFavorite(services, await fetchInput());
      toast.success('Saved to your gallery ⭐');
      onClose();
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't save that meme."));
      setBusy(null);
    }
  };

  return (
    <Modal label={post.title} onClose={onClose} variant="sheet">
      <div className="sheet-body">
        <div className="sheet-media">
          <img src={post.imageUrl} alt={post.title} referrerPolicy="no-referrer" />
        </div>
        <h2 className="sheet-title">{post.title}</h2>
        <p className="sheet-meta">
          r/{post.subreddit} · u/{post.author} · ▲ {formatScore(post.score)}
          {post.nsfw && <span className="badge badge-nsfw inline">NSFW</span>}
        </p>
        <div className="sheet-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={send} disabled={!!busy} data-autofocus>
            {busy === 'send' ? <span className="spinner sm on-accent" /> : <Icon name="send" size={18} />} Send to {partner}
          </button>
          <button type="button" className="btn btn-soft btn-lg" onClick={save} disabled={!!busy}>
            {busy === 'save' ? <span className="spinner sm" /> : <Icon name="star" size={18} />} Save to gallery
          </button>
        </div>
        <a className="link-btn small" href={redditUrl(post.permalink)} target="_blank" rel="noopener noreferrer">
          View on Reddit <Icon name="external" size={14} />
        </a>
      </div>
    </Modal>
  );
}
