"use client";
import { request } from "@/lib/api";
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useConfirm } from "./feedback";
import { useGlide } from "./motion";
import { useToast } from "./toast";

export type Row = Record<string, any>;
export type Tone = "neutral" | "ok" | "warn" | "bad" | "busy";

/* ---------- Buttons ---------- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm" | "icon";

export function btn(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = "") {
  return `btn btn--${variant}${size === "md" ? "" : ` btn--${size}`}${extra ? ` ${extra}` : ""}`;
}

export function Button({
  children,
  busy = false,
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      {...props}
      type={type}
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
      className={btn(variant, size, className)}
    >
      {busy ? <LoaderCircle className="spin" /> : null}
      {children}
    </button>
  );
}

/* ---------- Page structure ---------- */

export function PageHeader({
  title,
  description,
  actions,
  meta,
  crumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  crumb?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        {crumb}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
        {meta ? <div className="page-header__meta">{meta}</div> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  flush = false,
  className = "",
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`card${flush ? " card--flush" : ""}${className ? ` ${className}` : ""}`}>
      {title || actions ? (
        <div className="card__head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children ? <div className="card__body">{children}</div> : null}
    </section>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
}) {
  return (
    <input
      type="search"
      className="input input--search"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  useGlide(box, '[aria-pressed="true"]', value);
  return (
    <div className="segmented glide" role="group" aria-label={label} ref={setBox}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Feedback ---------- */

export function Notice({
  children,
  tone = "neutral",
  title,
  action,
  className = "",
}: {
  children?: ReactNode;
  tone?: Tone;
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`notice notice--${tone}${className ? ` ${className}` : ""}`}
      role={tone === "bad" ? "alert" : "status"}
    >
      <NoticeIcon tone={tone} />
      <div className="notice__text">
        {title ? <strong>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="notice__action">{action}</div> : null}
    </div>
  );
}

function NoticeIcon({ tone }: { tone: Tone }) {
  const Icon = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert, busy: LoaderCircle, neutral: Info }[tone];
  return <Icon className={`notice__icon${tone === "busy" ? " spin" : ""}`} aria-hidden="true" />;
}

export function ErrorNotice({ message }: { message?: string }) {
  return message ? <Notice tone="bad">{message}</Notice> : null;
}

export function Empty({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-label="Loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

export function State({
  loading,
  error,
  children,
  rows,
}: {
  loading: boolean;
  error: string;
  children: ReactNode;
  rows?: number;
}) {
  if (loading) return <Skeleton rows={rows} />;
  if (error) return <ErrorNotice message={error} />;
  return <>{children}</>;
}

/* ---------- Status ---------- */

const statusCopy: Record<string, string> = {
  connected: "Connected",
  disconnected: "Offline",
  unreachable: "Unreachable",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
  queued: "Queued",
  provisioning: "Provisioning",
  succeeded: "Succeeded",
  draining: "Draining",
  active: "Active",
  suspended: "Suspended",
  deleting: "Deleting",
  missing: "Missing",
  pending: "Pending",
};

export function toneOf(value: string): Tone {
  if (["connected", "running", "succeeded", "active"].includes(value)) return "ok";
  if (["failed", "disconnected", "unreachable", "missing"].includes(value)) return "bad";
  if (["draining", "suspended", "stopped"].includes(value)) return value === "stopped" ? "neutral" : "warn";
  if (["queued", "provisioning", "deleting", "pending", "starting", "restarting", "stopping"].includes(value)) return "busy";
  return "neutral";
}

export function Status({
  value,
  label,
  tone,
  live = false,
  pill = false,
}: {
  value?: string;
  label?: ReactNode;
  tone?: Tone;
  /** Adds a slow breathing halo to an "ok" dot. Use once per screen, for the thing being watched. */
  live?: boolean;
  pill?: boolean;
}) {
  const v = value || "unknown";
  const t = tone || toneOf(v);
  const text = statusCopy[v] ?? v[0].toUpperCase() + v.slice(1);
  return (
    <span
      className={`status status--${t}${live && t === "ok" ? " status--live" : ""}${pill ? " status-pill" : ""}`}
      title={label === "" ? text : undefined}
    >
      <span className="status__dot" aria-hidden="true" />
      {label === "" ? <span className="sr-only">{text}</span> : (label ?? text)}
    </span>
  );
}

export function Meter({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const tone = percent >= 90 ? "bad" : percent >= 75 ? "warn" : "ok";
  return (
    <div
      className={`meter meter--${tone}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Accessible on/off toggle. */
export function Switch({
  checked,
  onChange,
  label,
  busy = false,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    />
  );
}

/** Toggle chip for a checkbox in a group (e.g. permissions). */
export function CheckChip({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m3.5 8.5 3 3 6-7" />
      </svg>
      {label}
    </label>
  );
}

/* ---------- Forms ---------- */

/** Number input with its unit shown inside the field. */
export function UnitField({
  label,
  name,
  unit,
  step,
  defaultValue,
  value,
  onChange,
  min,
}: {
  label: string;
  name: string;
  unit: string;
  step: number;
  defaultValue?: number;
  value?: number;
  onChange?: (n: number) => void;
  min?: number;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <span className="input-unit">
        <input
          className="input"
          name={name}
          type="number"
          min={min ?? step}
          step={step}
          required
          defaultValue={defaultValue}
          value={value === undefined ? undefined : Number.isFinite(value) ? value : ""}
          onChange={onChange ? (e) => onChange(e.target.valueAsNumber) : undefined}
        />
        <span aria-hidden="true">{unit}</span>
      </span>
    </label>
  );
}


export function Field({
  label,
  name,
  type = "text",
  required = false,
  min,
  max,
  defaultValue,
  placeholder,
  hint,
  autoComplete,
  pattern,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  defaultValue?: string | number;
  placeholder?: string;
  hint?: ReactNode;
  autoComplete?: string;
  pattern?: string;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="input"
        name={name}
        type={type}
        required={required}
        min={min}
        max={max}
        minLength={type === "password" && !required ? 12 : undefined}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete={autoComplete}
        pattern={pattern}
      />
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Select({
  label,
  name,
  children,
  required = true,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  children: ReactNode;
  required?: boolean;
  defaultValue?: string;
  hint?: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select className="input select" name={name} required={required} defaultValue={defaultValue}>
        {children}
      </select>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Form({
  children,
  onSubmit,
  submit = "Save",
  danger = false,
  success = "Saved",
  secondary,
}: {
  children: ReactNode;
  onSubmit: (values: Row) => Promise<void | string>;
  submit?: string;
  danger?: boolean;
  success?: string | false;
  secondary?: ReactNode;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  async function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const message = await onSubmit(
        Object.fromEntries(new FormData(e.currentTarget).entries()),
      );
      if (success !== false) toast({ tone: "ok", title: message || success });
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={run} className="form">
      {children}
      <ErrorNotice message={err} />
      <div className="form__actions">
        <Button type="submit" busy={busy} variant={danger ? "danger" : "primary"}>
          {submit}
        </Button>
        {secondary}
      </div>
    </form>
  );
}

/** Runs an async action behind a confirmation dialog and reports failures inline. */
export function Confirm({
  text,
  onConfirm,
  children,
  danger = true,
  confirmLabel,
  variant,
  size = "sm",
}: {
  text: string;
  onConfirm: () => Promise<void>;
  children: ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      busy={busy}
      size={size}
      variant={variant || (danger ? "danger" : "secondary")}
      onClick={async () => {
        if (!(await confirm(text, { danger, confirmLabel }))) return;
        setBusy(true);
        try {
          await onConfirm();
        } catch (e) {
          toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </Button>
  );
}

export function Pager({
  offset,
  setOffset,
  count,
  size = 50,
}: {
  offset: number;
  setOffset: (n: number) => void;
  count: number;
  size?: number;
}) {
  if (offset === 0 && count < size) return null;
  return (
    <div className="pager">
      <span>{count ? `${offset + 1}–${offset + count}` : "No entries"}</span>
      <div>
        <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - size))}>
          Previous
        </Button>
        <Button size="sm" disabled={count < size} onClick={() => setOffset(offset + size)}>
          Next
        </Button>
      </div>
    </div>
  );
}

/* ---------- Data ---------- */

export function useLoad<T>(path: string | null, interval = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    sequence = useRef(0),
    loaded = useRef(false);
  const reload = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ticket = ++sequence.current;
    try {
      const value = await request<T>(path);
      if (sequence.current === ticket) {
        loaded.current = true;
        setData(value);
        setError("");
      }
    } catch (e) {
      // A failed background refresh keeps what's on screen; only a failed
      // first load (or a changed path) shows the error.
      if (sequence.current === ticket && !loaded.current) {
        setData(null);
        setError((e as Error).message);
      }
    } finally {
      if (sequence.current === ticket) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    ++sequence.current;
    loaded.current = false;
    setLoading(true);
    setData(null);
    setError("");
    reload();
    const timer = interval ? setInterval(reload, interval) : null;
    return () => {
      ++sequence.current;
      if (timer) clearInterval(timer);
    };
  }, [reload, interval]);
  return { data, error, loading, reload };
}
