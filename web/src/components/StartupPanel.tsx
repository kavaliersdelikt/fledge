"use client";
import { json, type ServerStartup, type VariableDef } from "@/lib/api";
import { Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Button, Card, ErrorNotice, Notice, Switch } from "./shared";
import { useToast } from "./toast";

type Env = ServerStartup["env"][number];

const isOn = (v: string) => /^(true|1)$/i.test(v.trim());

/** Mirrors the API's checks so mistakes are caught before the round trip. */
export function checkVariable(def: VariableDef, raw: string): string {
  const label = def.label || def.key;
  if (raw === "") return def.required ? `${label} is required.` : "";
  switch (def.type) {
    case "number": {
      const n = Number(raw);
      if (!/^-?\d+(\.\d+)?$/.test(raw.trim()) || !Number.isFinite(n)) return `${label} must be a number.`;
      if (def.min !== undefined && n < def.min) return `${label} must be at least ${def.min}.`;
      if (def.max !== undefined && n > def.max) return `${label} must be at most ${def.max}.`;
      return "";
    }
    case "boolean":
      return "";
    case "select":
      return def.options?.some((o) => o.value === raw) ? "" : `Choose one of the listed options for ${label}.`;
    default:
      if (def.min !== undefined && raw.length < def.min) return `${label} must be at least ${def.min} characters.`;
      if (def.max !== undefined && raw.length > def.max) return `${label} must be at most ${def.max} characters.`;
      if (def.pattern) {
        try {
          if (!new RegExp(def.pattern).test(raw)) return `${label} isn’t in the expected format.`;
        } catch {
          /* the API validates definitions; ignore patterns this browser can't compile */
        }
      }
      return "";
  }
}

/** The variables an owner may change, rendered by their typed definitions. */
export function StartupVariables({ id, startup, onSaved }: { id: string; startup: ServerStartup; onSaved: () => void }) {
  const toast = useToast();
  const defs = startup.variables;
  const current = (def: VariableDef) => startup.env.find((e) => e.key === def.key)?.value ?? "";
  const initial = (def: VariableDef): string | boolean => (def.type === "boolean" ? isOn(current(def)) : current(def));
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(defs.map((d) => [d.key, initial(d)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  if (!defs.length) return <p className="muted">This template has no variables you can change.</p>;

  const changed = defs.filter((d) => values[d.key] !== initial(d));
  const set = (key: string, value: string | boolean) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "" }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const found: Record<string, string> = {};
    for (const d of changed) {
      const v = values[d.key];
      const message = typeof v === "string" ? checkVariable(d, v) : "";
      if (message) found[d.key] = message;
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    if (!changed.length) {
      setError("Nothing changed.");
      return;
    }
    setBusy(true);
    try {
      const variables = Object.fromEntries(changed.map((d) => [d.key, String(values[d.key])]));
      await json("PATCH", `/servers/${id}/settings`, { variables });
      toast({ tone: "ok", title: "Saved — the server is being recreated" });
      onSaved();
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="form-grid">
        {defs
          .filter((d) => d.type !== "boolean")
          .map((d) => {
            const fid = `var-${d.key}`;
            const hiddenNow = startup.env.find((e) => e.key === d.key)?.hidden;
            const v = String(values[d.key] ?? "");
            const err = errors[d.key];
            return (
              <div className="field" key={d.key}>
                <label className="field__label" htmlFor={fid}>
                  {d.label || d.key}
                  {d.required ? <span className="req" aria-hidden="true"> *</span> : null}
                </label>
                {d.type === "select" ? (
                  <select id={fid} className="input select" value={v} aria-invalid={!!err} onChange={(e) => set(d.key, e.target.value)}>
                    {!d.required && !d.options?.some((o) => o.value === "") ? <option value="">Template default</option> : null}
                    {v && !d.options?.some((o) => o.value === v) ? <option value={v}>{v}</option> : null}
                    {(d.options || []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : d.secret ? (
                  <span className="reveal">
                    <input
                      id={fid}
                      className="input mono"
                      type={shown[d.key] ? "text" : "password"}
                      value={v}
                      autoComplete="new-password"
                      spellCheck={false}
                      aria-invalid={!!err}
                      placeholder={hiddenNow ? "Hidden. Leave empty to keep it" : ""}
                      onChange={(e) => set(d.key, e.target.value)}
                    />
                    <button type="button" className="reveal__btn" aria-label={shown[d.key] ? `Hide ${d.label || d.key}` : `Show ${d.label || d.key}`} aria-pressed={!!shown[d.key]} onClick={() => setShown((s) => ({ ...s, [d.key]: !s[d.key] }))}>
                      {shown[d.key] ? <EyeOff /> : <Eye />}
                    </button>
                  </span>
                ) : d.type === "number" ? (
                  <input id={fid} className="input" type="number" inputMode="decimal" step="any" min={d.min} max={d.max} value={v} aria-invalid={!!err} onChange={(e) => set(d.key, e.target.value)} />
                ) : (
                  <input id={fid} className="input" type="text" maxLength={4096} value={v} aria-invalid={!!err} onChange={(e) => set(d.key, e.target.value)} />
                )}
                {err ? <span className="inline-error">{err}</span> : null}
                {d.description ? <span className="field__hint">{d.description}</span> : null}
                {d.type === "string" && d.pattern && !err ? <span className="field__hint">Format: <span className="mono">{d.pattern}</span></span> : null}
                {d.type === "number" && (d.min !== undefined || d.max !== undefined) && !err ? (
                  <span className="field__hint">
                    {d.min !== undefined && d.max !== undefined ? `Between ${d.min} and ${d.max}` : d.min !== undefined ? `At least ${d.min}` : `At most ${d.max}`}
                  </span>
                ) : null}
              </div>
            );
          })}
      </div>
      {defs
        .filter((d) => d.type === "boolean")
        .map((d) => (
          <div className="toggle-row" key={d.key}>
            <div>
              <strong>{d.label || d.key}</strong>
              {d.description ? <small>{d.description}</small> : null}
            </div>
            <Switch label={d.label || d.key} checked={values[d.key] === true} onChange={(on) => set(d.key, on)} />
          </div>
        ))}
      <ErrorNotice message={error} />
      <div className="form__actions">
        <Button type="submit" variant="primary" busy={busy} disabled={!changed.length}>
          Save
        </Button>
        {changed.length ? <span className="small faint">{changed.length} unsaved {changed.length === 1 ? "change" : "changes"}</span> : null}
      </div>
    </form>
  );
}

/** Read-only view of what the server starts with. */
export function StartupCard({ startup, admin }: { startup: ServerStartup; admin: boolean }) {
  const columns: DataColumn<Env>[] = [
    {
      id: "key",
      header: "Variable",
      value: (e) => e.key,
      render: (e) => (
        <div className="cell-main">
          <strong className="mono" style={{ fontWeight: 400 }}>
            {e.key}
          </strong>
          {e.label && e.label !== e.key ? <small>{e.label}</small> : null}
        </div>
      ),
    },
    {
      id: "value",
      header: "Value",
      value: (e) => e.value ?? "",
      render: (e) => (e.hidden ? <span className="faint">Hidden</span> : <span className="mono small startup-value">{e.value === "" ? <span className="faint">empty</span> : e.value}</span>),
    },
    {
      id: "source",
      header: "Source",
      optional: true,
      value: (e) => e.source,
      render: (e) => <span className={`tag${e.source === "server" ? " tag--accent" : ""}`}>{e.source === "server" ? "Server" : "Template"}</span>,
    },
    {
      id: "editable",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (e) =>
        e.editable ? (
          <span className="startup-lock is-open" title="You can change this above">
            <LockOpen aria-hidden="true" />
            <span className="sr-only">Editable</span>
          </span>
        ) : (
          <span className="startup-lock" title="Set by the template">
            <Lock aria-hidden="true" />
            <span className="sr-only">Locked</span>
          </span>
        ),
    },
  ];
  const mappings = startup.ports.flatMap((p) => p.mapping);
  return (
    <Card title="Startup" description={`From the ${startup.templateName} template, version ${startup.templateVersion}. Read-only.`}>
      <div className="stack" style={{ gap: 16 }}>
        {admin && startup.outdated ? (
          <Notice
            tone="warn"
            title="This server runs an older template version"
            action={
              <Link href="/templates" className="btn btn--secondary btn--sm">
                Open Templates
              </Link>
            }
          >
            Template updated to v{startup.currentTemplateVersion}; this server runs v{startup.templateVersion}. Apply from Templates.
          </Notice>
        ) : null}
        <dl className="dl">
          <dt>Image</dt>
          <dd className="mono small">{startup.image}</dd>
          {startup.stopCommand ? (
            <>
              <dt>Stop command</dt>
              <dd className="mono small">{startup.stopCommand}</dd>
            </>
          ) : null}
          <dt>Ports</dt>
          <dd className="mono small">{mappings.length ? mappings.map((m) => `${m.host} → ${m.container}/${m.protocol}`).join("   ") : "—"}</dd>
        </dl>
        {startup.startup ? (
          <div className="field">
            <span className="field__label">Startup command</span>
            <pre className="code-block code-block--command">{startup.startup}</pre>
          </div>
        ) : null}
        {startup.env.length ? (
          <div className="field">
            <span className="field__label">Environment</span>
            <div className="startup-env">
              <DataTable data={startup.env} columns={columns} rowKey={(e) => e.key} />
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
