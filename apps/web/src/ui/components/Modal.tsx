import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  label: string;
  onClose: () => void;
  variant?: 'sheet' | 'dialog' | 'viewer';
  children: ReactNode;
  className?: string;
  role?: 'dialog' | 'alertdialog';
}

/** Accessible modal: backdrop, Escape to close, focus trap, focus restore. */
export function Modal({ label, onClose, variant = 'sheet', children, className, role = 'dialog' }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el;
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const a = items[0]!;
        const z = items[items.length - 1]!;
        if (e.shiftKey && (document.activeElement === a || document.activeElement === el)) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('modal-open');
      prev?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <div className={`modal modal-${variant}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={`modal-panel ${className ?? ''}`} role={role} aria-modal="true" aria-label={label} tabIndex={-1}>
        {variant === 'sheet' && <div className="sheet-grabber" aria-hidden="true" />}
        {children}
      </div>
    </div>
  );
}

// ─── Confirm dialog (promise API) ───────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const c = useContext(ConfirmContext);
  if (!c) throw new Error('useConfirm() must be used inside <ConfirmProvider>');
  return c;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>((opts) => new Promise((resolve) => setReq({ ...opts, resolve })), []);
  const done = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {req && (
        <Modal label={req.title} onClose={() => done(false)} variant="dialog" role="alertdialog">
          <h2 className="dialog-title">{req.title}</h2>
          {req.body && <div className="dialog-body">{req.body}</div>}
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => done(false)} data-autofocus>
              {req.cancelLabel ?? 'Cancel'}
            </button>
            <button type="button" className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)}>
              {req.confirmLabel ?? 'OK'}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}
