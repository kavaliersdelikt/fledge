"use client";
import { CircleAlert, CircleCheck, Info, LoaderCircle, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Tone = "ok" | "bad" | "busy" | "neutral";
type Toast = { id: number; tone: Tone; title: string; description?: string; leaving?: boolean };
type Push = (toast: Omit<Toast, "id" | "leaving">) => void;

const ToastContext = createContext<Push>(() => {});

/** Shows short-lived feedback for completed actions, e.g. "Restart queued". */
export function useToast() {
  return useContext(ToastContext);
}

const icons = { ok: CircleCheck, bad: CircleAlert, busy: LoaderCircle, neutral: Info };
const LIFETIME = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((xs) => xs.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((xs) => xs.filter((t) => t.id !== id)), 180);
  }, []);
  const push = useCallback<Push>((toast) => {
    const id = ++next.current;
    setToasts((xs) => [...xs.slice(-3), { ...toast, id }]);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(LIFETIME);
  useEffect(() => {
    if (paused || toast.leaving) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, toast.id, toast.leaving, onDismiss]);
  const Icon = icons[toast.tone];
  return (
    <div
      className={`toast toast--${toast.tone}`}
      data-leaving={toast.leaving || undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className={`toast__icon${toast.tone === "busy" ? " spin" : ""}`} aria-hidden="true" />
      <div className="toast__text">
        <strong>{toast.title}</strong>
        {toast.description ? <span>{toast.description}</span> : null}
      </div>
      <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        <X />
      </button>
    </div>
  );
}
