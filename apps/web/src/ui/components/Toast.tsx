import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  /** ms; 0 = sticky until dismissed. Default 3500 (errors 5000). */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

interface ToastApi {
  show(message: string, opts?: ToastOptions): number;
  dismiss(id: number): void;
  error(message: string): number;
  success(message: string): number;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const t = useContext(ToastContext);
  if (!t) throw new Error('useToast() must be used inside <ToastProvider>');
  return t;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (message: string, opts: ToastOptions = {}) => {
      const id = nextId.current++;
      setItems((xs) => [...xs.filter((x) => x.message !== message).slice(-2), { id, message, ...opts }]);
      const duration = opts.duration ?? (opts.kind === 'error' ? 5000 : 3500);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      error: (m) => show(m, { kind: 'error' }),
      success: (m) => show(m, { kind: 'success' }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind ?? 'info'}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
