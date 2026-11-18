import { useState, type ReactNode } from 'react';
import { useMeme, usePartnerName, useServices } from '../context';
import { friendlyError } from '../errors';
import { Icon } from './Icon';
import { Modal, useConfirm } from './Modal';
import { useToast } from './Toast';

/** A meme from the local library, with a "receiving…" placeholder until its bytes arrive. */
export function MemeImage({
  memeId,
  alt,
  fit = 'contain',
  onLoad,
  maxAspect = 1.3,
}: {
  memeId: string;
  alt?: string;
  fit?: 'contain' | 'cover';
  onLoad?: () => void;
  /** Cap tall images (height/width) in bubbles. */
  maxAspect?: number;
}) {
  const { url, meta } = useMeme(memeId);
  const ratio = meta ? Math.min(meta.height / meta.width, maxAspect) : 1;
  const label = alt ?? meta?.title ?? 'Meme';
  if (!url) {
    return (
      <div className="meme-placeholder" style={fit === 'contain' ? { aspectRatio: `1 / ${ratio}` } : undefined} role="img" aria-label={`${label} (receiving…)`}>
        <span className="spinner" aria-hidden="true" />
        <span>Receiving…</span>
      </div>
    );
  }
  return (
    <img
      className={`meme-img meme-img-${fit}`}
      src={url}
      alt={label}
      style={fit === 'contain' ? { aspectRatio: `1 / ${ratio}` } : undefined}
      onLoad={onLoad}
      draggable={false}
      decoding="async"
    />
  );
}

export interface ViewerActions {
  send?: boolean;
  favorite?: boolean;
  remove?: boolean;
}

/** Fullscreen viewer for a library meme. */
export function MemeViewer({
  memeId,
  onClose,
  actions = { favorite: true },
  onSent,
  footer,
}: {
  memeId: string;
  onClose: () => void;
  actions?: ViewerActions;
  onSent?: () => void;
  footer?: ReactNode;
}) {
  const services = useServices();
  const { url, meta } = useMeme(memeId);
  const partner = usePartnerName();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal label={meta?.title ?? 'Meme'} onClose={onClose} variant="viewer">
      <div className="viewer-top">
        <button type="button" className="icon-btn on-dark" aria-label="Close" onClick={onClose} data-autofocus>
          <Icon name="close" />
        </button>
        {meta?.title && <p className="viewer-title">{meta.title}</p>}
      </div>
      <div className="viewer-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {url ? <img src={url} alt={meta?.title ?? 'Meme'} className="viewer-img" /> : <div className="meme-placeholder big"><span className="spinner" /> Receiving…</div>}
      </div>
      <div className="viewer-actions">
        {actions.send && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await services.chat.sendMeme(memeId);
                toast.success(`Sent to ${partner}`);
                onSent?.();
              })
            }
          >
            <Icon name="send" size={18} /> Send to {partner}
          </button>
        )}
        {actions.favorite && meta && (
          <button
            type="button"
            className={`btn btn-glass ${meta.favorite ? 'is-on' : ''}`}
            aria-pressed={meta.favorite}
            disabled={busy}
            onClick={() => run(async () => void (await services.library.toggleFavorite(memeId)))}
          >
            <Icon name="star" size={18} filled={meta.favorite} /> {meta.favorite ? 'Favorited' : 'Favorite'}
          </button>
        )}
        {actions.remove && (
          <button
            type="button"
            className="btn btn-glass btn-icon-only"
            aria-label="Delete from this device"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const ok = await confirm({
                  title: 'Delete this meme?',
                  body: 'It will be removed from this device. Chat messages that use it will show a placeholder.',
                  confirmLabel: 'Delete',
                  danger: true,
                });
                if (!ok) return;
                await services.library.remove(memeId);
                toast.show('Deleted');
                onClose();
              })
            }
          >
            <Icon name="trash" size={18} />
          </button>
        )}
      </div>
      {footer}
    </Modal>
  );
}
