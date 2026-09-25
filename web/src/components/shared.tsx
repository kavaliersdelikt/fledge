"use client";
import { request } from "@/lib/api";
import { RefreshCw } from "lucide-react";
import { Alert } from "@heroui/react";
import {
useCallback,
useEffect,
useRef,
useState,
type FormEvent,
type ReactNode,
} from "react";
import { useConfirm } from "./feedback";
export type Row = Record<string, any>;
export type NoticeStatus = "default" | "accent" | "success" | "warning" | "danger";

export function Notice({
  children,
  status = "default",
  title,
  className = "",
  role = status === "danger" ? "alert" : "status",
}: {
  children: ReactNode;
  status?: NoticeStatus;
  title?: string;
  className?: string;
  role?: "alert" | "status";
}) {
  return (
    <Alert status={status} className={`fledge-alert ${className}`} role={role}>
      <Alert.Indicator />
      <Alert.Content>
        {title ? <Alert.Title>{title}</Alert.Title> : null}
        <Alert.Description className="alert__description">
          {children}
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <Notice status="danger" title="Something went wrong">{message}</Notice>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Button({
  children,
  busy = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      className={`btn ${props.className || ""}`}
    >
      {busy ? <RefreshCw size={15} className="spin" /> : null}
      {children}
    </button>
  );
}
export function Field({
  label,
  name,
  type = "text",
  required = false,
  min,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  min?: number;
  defaultValue?: string | number;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        min={min}
        minLength={type === "password" && !required ? 12 : undefined}
        defaultValue={defaultValue}
        placeholder={placeholder}
      />
    </label>
  );
}
export function Select({
  label,
  name,
  children,
  required = true,
  defaultValue,
}: {
  label: string;
  name: string;
  children: ReactNode;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} required={required} defaultValue={defaultValue}>
        {children}
      </select>
    </label>
  );
}
export function Badge({ value }: { value?: string }) {
  const s = value || "unknown";
  const tone = ["connected", "running", "succeeded", "active"].includes(s)
    ? "good"
    : ["failed", "disconnected", "unreachable", "suspended"].includes(s)
      ? "bad"
      : "neutral";
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" />
      {(
        {
          connected: "Connected",
          disconnected: "Unreachable",
          unreachable: "Node unreachable",
          running: "Running",
          stopped: "Stopped",
          failed: "Failed",
          queued: "Queued",
          provisioning: "Provisioning",
          succeeded: "Succeeded",
          draining: "Draining",
        } as Row
      )[s] || s}
    </span>
  );
}
export function useLoad<T>(path: string | null, interval = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    sequence = useRef(0);
  const reload = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ticket = ++sequence.current;
    try {
      const value = await request<T>(path);
      if (sequence.current === ticket) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (sequence.current === ticket) {
        setData(null);
        setError((e as Error).message);
      }
    } finally {
      if (sequence.current === ticket) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    ++sequence.current;
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
export function State({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: string;
  children: ReactNode;
}) {
  return (
    <>
      {loading ? <div className="skeleton" aria-label="Loading data" /> : null}
      {error ? <ErrorBox message={error} /> : null}
      {!loading && !error && children}
    </>
  );
}
export function Section({
  title,
  description,
  children,
  action,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`section ${className}`}>
      <div className="section-title">
        <div>
          <h2>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Form({
  children,
  onSubmit,
  submit = "Save",
  danger = false,
}: {
  children: ReactNode;
  onSubmit: (values: Row) => Promise<void>;
  submit?: string;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [err, setErr] = useState(""),
    [ok, setOk] = useState("");
  async function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setOk("");
    try {
      await onSubmit(
        Object.fromEntries(new FormData(e.currentTarget).entries()),
      );
      setOk("Request succeeded.");
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={run} className="form">
      {children}
      {err && <ErrorBox message={err} />}
      <div className="form-actions">
        <Button
          type="submit"
          busy={busy}
          className={danger ? "danger" : "primary"}
        >
          {submit}
        </Button>
        {ok && (
          <Notice status="success" className="form-success">
            {ok}
          </Notice>
        )}
      </div>
    </form>
  );
}
export function Confirm({
  text,
  onConfirm,
  children,
  danger = true,
}: {
  text: string;
  onConfirm: () => Promise<void>;
  children: ReactNode;
  danger?: boolean;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  return (
    <>
      <Button
        type="button"
        busy={busy}
        className={danger ? "subtle-danger" : ""}
        onClick={async () => {
          if (!(await confirm(text))) return;
          setBusy(true);
          setErr("");
          try {
            await onConfirm();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </Button>
      {err && <ErrorBox message={err} />}
    </>
  );
}
export function Pager({
  offset,
  setOffset,
  count,
}: {
  offset: number;
  setOffset: (n: number) => void;
  count: number;
}) {
  return (
    <div className="pager">
      <Button
        disabled={offset === 0}
        onClick={() => setOffset(Math.max(0, offset - 50))}
      >
        Back
      </Button>
      <span>{count ? `${offset + 1}–${offset + count}` : "No entries"}</span>
      <Button disabled={count < 50} onClick={() => setOffset(offset + 50)}>
        Next
      </Button>
    </div>
  );
}
export function Heading({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
