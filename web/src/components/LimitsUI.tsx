"use client";
import type { LimitRow, LimitsView } from "@/lib/commerce";
import { useState } from "react";
import { Meter, Notice } from "./shared";

/** One layer of limits as the API stores it: a number is a cap, null is unlimited, a missing key inherits. */
export type LimitSet = Record<string, number | boolean | string[] | null | undefined>;

type Unit = "count" | "gb" | "cores";
type Field = { key: string; label: string; unit: Unit; hint?: string };
export const NUMBER_FIELDS: { title: string; fields: Field[] }[] = [
  {
    title: "Totals across all servers",
    fields: [
      { key: "servers", label: "Servers", unit: "count" },
      { key: "runningServers", label: "Running at the same time", unit: "count", hint: "Servers that are switched on." },
      { key: "memoryMb", label: "Memory", unit: "gb" },
      { key: "cpuPercent", label: "CPU", unit: "cores" },
      { key: "diskMb", label: "Disk", unit: "gb" },
    ],
  },
  {
    title: "Per server",
    fields: [
      { key: "maxServerMemoryMb", label: "Memory per server", unit: "gb" },
      { key: "maxServerCpuPercent", label: "CPU per server", unit: "cores" },
      { key: "maxServerDiskMb", label: "Disk per server", unit: "gb" },
      { key: "collaboratorsPerServer", label: "People a server can be shared with", unit: "count" },
      { key: "schedulesPerServer", label: "Scheduled tasks per server", unit: "count" },
    ],
  },
  {
    title: "Backups and ports",
    fields: [
      { key: "backups", label: "Backups in total", unit: "count" },
      { key: "backupsPerServer", label: "Backups per server", unit: "count" },
      { key: "backupStorageMb", label: "Backup storage", unit: "gb" },
      { key: "extraPorts", label: "Extra ports", unit: "count" },
    ],
  },
];
export const FLAG_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "selfCreate", label: "May create servers", hint: "Needs self-service to be on in Settings, Customers." },
  { key: "selfDelete", label: "May delete their own servers", hint: "Needs deleting to be allowed in Settings, Customers." },
  { key: "sftp", label: "May use SFTP", hint: "File access with an SFTP client." },
  { key: "addons", label: "May install mods and plugins", hint: "The add-on browsers on a server." },
  { key: "schedules", label: "May schedule tasks", hint: "Automatic backups and commands." },
  { key: "collaborators", label: "May share servers", hint: "Add other people to a server." },
  { key: "extraPortsAllowed", label: "May add extra ports", hint: "Only if an extra-ports limit is set above." },
];

const factor: Record<Unit, number> = { count: 1, gb: 1024, cores: 100 };
const step: Record<Unit, string> = { count: "1", gb: "0.25", cores: "0.25" };
const unitText: Record<Unit, string> = { count: "", gb: "GB", cores: "cores" };
const show = (v: number, unit: Unit) => String(+(v / factor[unit]).toFixed(3));

function NumberField({ field, value, onChange, inherit }: { field: Field; value: number | null | undefined; onChange: (v: number | null | undefined) => void; inherit: string }) {
  const unlimited = value === null;
  return (
    <div className="field">
      <span className="field__label">{field.label}</span>
      <span className={field.unit === "count" ? undefined : "input-unit"}>
        <input
          className="input"
          type="number"
          inputMode="decimal"
          min={0}
          step={step[field.unit]}
          disabled={unlimited}
          value={typeof value === "number" ? show(value, field.unit) : ""}
          placeholder={unlimited ? "No limit" : inherit}
          aria-label={field.label}
          onChange={(e) => {
            const t = e.target.value;
            onChange(t === "" ? undefined : Math.round(Number(t) * factor[field.unit]));
          }}
        />
        {field.unit !== "count" ? <span aria-hidden="true">{unitText[field.unit]}</span> : null}
      </span>
      <label className="auth__check" style={{ marginTop: 4 }}>
        <input type="checkbox" checked={unlimited} onChange={(e) => onChange(e.target.checked ? null : undefined)} />
        <span>No limit</span>
      </label>
      {field.hint ? <span className="field__hint">{field.hint}</span> : null}
    </div>
  );
}

/** Edits a layer of limits. Empty fields inherit from the layer below; "No limit" is a decision of its own. */
export function LimitSetEditor({
  value,
  onChange,
  inherit = "Not set",
  templates = [],
  locations = [],
  flags = true,
}: {
  value: LimitSet;
  onChange: (v: LimitSet) => void;
  inherit?: string;
  templates?: { id: string; name: string }[];
  locations?: string[];
  flags?: boolean;
}) {
  const set = (key: string, v: LimitSet[string]) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const list = (key: string, all: { id: string; name: string }[]) => {
    const current = value[key];
    const restricted = Array.isArray(current);
    return (
      <div className="field">
        <span className="field__label">{key === "allowedTemplates" ? "Kinds of server they may create" : "Locations they may use"}</span>
        <label className="auth__check">
          <input type="checkbox" checked={!restricted} onChange={(e) => set(key, e.target.checked ? undefined : all.map((a) => a.id))} />
          <span>{inherit === "Not set" ? "All (not restricted)" : "All, unless a higher layer says otherwise"}</span>
        </label>
        {restricted ? (
          <div className="chips">
            {all.map((a) => {
              const on = (current as string[]).includes(a.id);
              return (
                <label className="check" key={a.id}>
                  <input type="checkbox" checked={on} onChange={(e) => set(key, e.target.checked ? [...(current as string[]), a.id] : (current as string[]).filter((x) => x !== a.id))} />
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m3.5 8.5 3 3 6-7" />
                  </svg>
                  {a.name}
                </label>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="stack">
      {NUMBER_FIELDS.map((g) => (
        <fieldset className="form-section" key={g.title} style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>{g.title}</h3>
          <div className="form-grid">
            {g.fields.map((f) => (
              <NumberField key={f.key} field={f} inherit={inherit} value={value[f.key] as number | null | undefined} onChange={(v) => set(f.key, v)} />
            ))}
          </div>
        </fieldset>
      ))}
      {flags ? (
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>What they may do</h3>
          <div className="form-grid">
            {FLAG_FIELDS.map((f) => {
              const v = value[f.key];
              return (
                <label className="field" key={f.key}>
                  <span className="field__label">{f.label}</span>
                  <select className="input select" value={v === undefined ? "" : v ? "yes" : "no"} onChange={(e) => set(f.key, e.target.value === "" ? undefined : e.target.value === "yes")}>
                    <option value="">{inherit}</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                  <span className="field__hint">{f.hint}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
        <h3>Where and what</h3>
        <div className="form-grid">
          {list("allowedTemplates", templates)}
          {list("allowedLocations", locations.map((l) => ({ id: l, name: l })))}
        </div>
      </fieldset>
    </div>
  );
}

/** Wording for the usage list; the API's own labels are written for sentences ("memory (MB)"). */
const PRETTY: Record<string, string> = {
  servers: "Servers", runningServers: "Running servers", memoryMb: "Memory", cpuPercent: "CPU", diskMb: "Disk", maxServerMemoryMb: "Memory per server", maxServerCpuPercent: "CPU per server",
  maxServerDiskMb: "Disk per server", backups: "Backups", backupsPerServer: "Backups per server", backupStorageMb: "Backup storage", extraPorts: "Extra ports",
  collaboratorsPerServer: "Shared with, per server", schedulesPerServer: "Scheduled tasks per server",
};
const fmtRow = (r: LimitRow, n: number) => {
  if (/memory|disk|storage/i.test(r.key)) return n >= 1024 ? `${+(n / 1024).toFixed(2)} GB` : `${n} MB`;
  if (/cpu/i.test(r.key)) return `${+(n / 100).toFixed(2)} cores`;
  return String(n);
};
const sourceLabel: Record<string, string> = { default: "Default", plan: "Plan", override: "Set by your host", none: "" };

/** Usage against the limits that apply, with where each limit comes from. */
export function LimitUsage({ view, adminView = false }: { view: LimitsView; adminView?: boolean }) {
  const rows = view.rows.filter((r) => !r.unlimited || (r.used && r.used > 0 && !/per server/i.test(r.label)));
  const [all, setAll] = useState(false);
  const shown = all ? view.rows : rows;
  if (!view.enabled)
    return <Notice tone="neutral">Limits are switched off, so nothing here is enforced.</Notice>;
  return (
    <div className="stack">
      {view.mode === "warn" ? <Notice tone="warn">Limits only warn right now: nothing is blocked.</Notice> : null}
      <ul className="limit-list">
        {shown.map((r) => {
          const share = r.limit && r.used !== null ? Math.min(100, Math.round((r.used / r.limit) * 100)) : 0;
          const perServer = /^max|PerServer$/.test(r.key);
          return (
            <li className="limit-row" key={r.key}>
              <div className="limit-row__text">
                <span>
                  {PRETTY[r.key] || r.label}{" "}
                  {r.source !== "none" && (adminView || r.source === "plan") ? (
                    <span className={`source source--${r.source}`}>{r.source === "plan" && r.plans.length ? r.plans.join(", ") : sourceLabel[r.source]}</span>
                  ) : null}
                </span>
                <strong>
                  {perServer
                    ? r.unlimited
                      ? "No limit"
                      : fmtRow(r, r.limit as number)
                    : r.unlimited
                      ? `${fmtRow(r, r.used ?? 0)} · no limit`
                      : `${fmtRow(r, r.used ?? 0)} / ${fmtRow(r, r.limit as number)}`}
                </strong>
              </div>
              {!perServer && !r.unlimited && r.limit ? <Meter label={`${r.label} in use`} value={Math.min(r.used ?? 0, r.limit)} max={r.limit} /> : null}
              {share >= 100 && !perServer ? <small>Limit reached</small> : null}
            </li>
          );
        })}
      </ul>
      {view.rows.length > rows.length ? (
        <button type="button" className="text-button" onClick={() => setAll(!all)}>
          {all ? "Show only what matters" : `Show all ${view.rows.length} limits`}
        </button>
      ) : null}
    </div>
  );
}
