"use client";
import { items, json, type Template } from "@/lib/api";
import { CYCLES, cycleLabel, fromMinor, memText, money, toMinor, type Cycle } from "@/lib/commerce";
import { Copy, Pencil, Plus, Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Drawer } from "./feedback";
import { LimitSetEditor, type LimitSet } from "./LimitsUI";
import { Button, Card, Confirm, ErrorNotice, Notice, Row, State, Status, Switch, useLoad } from "./shared";
import { useToast } from "./toast";

type Price = { cycle: Cycle; amount: number; currency: string; trialDays: number; setupFee: number };
type Plan = {
  id: string; slug: string; name: string; description: string; kind: "server" | "account"; visibility: "public" | "hidden" | "private"; active: boolean; features: string[];
  preset: { templateId?: string; memoryMb?: number; cpuPercent?: number; diskMb?: number; locations?: string[]; allowLocationChoice?: boolean; allowNameChoice?: boolean; variables?: Record<string, string>; editableVariables?: string[] };
  limits: LimitSet; options: { highlight?: boolean; badge?: string; free?: boolean; note?: string }; stock: number | null; perCustomerMax: number; trialOnce: boolean; retentionDays: number | null;
  archivedAt: string | null; prices: (Price & { id?: string })[]; subscribers?: number; pendingOrders?: number; remaining?: number | null;
};
type TemplateFull = Template & { variables?: { key: string; label: string; userEditable: boolean }[] };

const blank = (currency: string): Plan => ({
  id: "", slug: "", name: "", description: "", kind: "server", visibility: "public", active: true, features: [],
  preset: { memoryMb: 2048, cpuPercent: 100, diskMb: 10240, locations: [], allowLocationChoice: true, allowNameChoice: true, variables: {}, editableVariables: [] },
  limits: {}, options: {}, stock: null, perCustomerMax: 1, trialOnce: true, retentionDays: null, archivedAt: null,
  prices: [{ id: "", cycle: "month", amount: 800, currency, trialDays: 0, setupFee: 0 }],
});

function PriceEditor({ prices, onChange, currencies, currency, setCurrency }: { prices: Price[]; onChange: (p: Price[]) => void; currencies: string[]; currency: string; setCurrency: (c: string) => void }) {
  const mine = (c: Cycle) => prices.find((p) => p.cycle === c && p.currency === currency);
  const [text, setText] = useState<Record<string, string>>({});
  const key = (c: Cycle, f: string) => `${currency}:${c}:${f}`;
  const read = (c: Cycle, f: "amount" | "setupFee") => {
    const k = key(c, f);
    if (text[k] !== undefined) return text[k];
    const p = mine(c);
    return p ? fromMinor(f === "amount" ? p.amount : p.setupFee, currency) : "";
  };
  const update = (c: Cycle, patch: Partial<Price>) => onChange(prices.map((p) => (p.cycle === c && p.currency === currency ? { ...p, ...patch } : p)));
  return (
    <div className="stack">
      <label className="field" style={{ maxWidth: 220 }}>
        <span className="field__label">Currency</span>
        <select className="input select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
      <div className="price-grid">
        <span className="head">Interval</span>
        <span className="head">Price</span>
        <span className="head">Trial (days)</span>
        <span className="head">One-time setup</span>
        <span className="head" />
        {CYCLES.map((c) => {
          const p = mine(c);
          return (
            <PriceRow
              key={c}
              cycle={c}
              enabled={!!p}
              onToggle={(on) => onChange(on ? [...prices, { cycle: c, amount: 800, currency, trialDays: 0, setupFee: 0 }] : prices.filter((x) => !(x.cycle === c && x.currency === currency)))}
              amount={read(c, "amount")}
              setup={read(c, "setupFee")}
              trial={p?.trialDays ?? 0}
              onAmount={(t) => {
                setText({ ...text, [key(c, "amount")]: t });
                const m = toMinor(t, currency);
                if (m !== null) update(c, { amount: m });
              }}
              onSetup={(t) => {
                setText({ ...text, [key(c, "setupFee")]: t });
                const m = toMinor(t || "0", currency);
                if (m !== null) update(c, { setupFee: m });
              }}
              onTrial={(n) => update(c, { trialDays: n })}
              invalid={p && (toMinor(read(c, "amount"), currency) === null)}
            />
          );
        })}
      </div>
      <p className="field__hint">Prices are never changed in place: changing one creates a new price for new customers, and people who already subscribed keep what they agreed to. A price of 0 makes the plan free.</p>
    </div>
  );
}

function PriceRow({ cycle, enabled, onToggle, amount, setup, trial, onAmount, onSetup, onTrial, invalid }: { cycle: Cycle; enabled: boolean; onToggle: (on: boolean) => void; amount: string; setup: string; trial: number; onAmount: (t: string) => void; onSetup: (t: string) => void; onTrial: (n: number) => void; invalid?: boolean }) {
  return (
    <>
      <label className="auth__check">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>{cycleLabel[cycle]}</span>
      </label>
      <input className="input" disabled={!enabled} inputMode="decimal" aria-label={`${cycleLabel[cycle]} price`} value={enabled ? amount : ""} aria-invalid={invalid || undefined} onChange={(e) => onAmount(e.target.value)} />
      <input className="input" disabled={!enabled} type="number" min={0} max={365} aria-label={`${cycleLabel[cycle]} trial days`} value={enabled ? trial : ""} onChange={(e) => onTrial(Math.max(0, Math.min(365, Number(e.target.value) || 0)))} />
      <input className="input" disabled={!enabled} inputMode="decimal" placeholder="0" aria-label={`${cycleLabel[cycle]} setup fee`} value={enabled ? setup : ""} onChange={(e) => onSetup(e.target.value)} />
      <span />
    </>
  );
}

function PlanForm({ initial, onClose, onSaved, currencies, defaultCurrency }: { initial: Plan; onClose: () => void; onSaved: () => void; currencies: string[]; defaultCurrency: string }) {
  const toast = useToast();
  const creating = !initial.id;
  const [p, setP] = useState<Plan>(initial);
  const [currency, setCurrency] = useState(initial.prices[0]?.currency || defaultCurrency);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const templates = useLoad<Template[]>("/templates");
  const nodes = useLoad<Row[]>("/nodes");
  const locations = useMemo(() => [...new Set(items(nodes.data).map((n) => n.location as string))].sort(), [nodes.data]);
  const tpl = items(templates.data).find((t) => t.id === p.preset.templateId) as TemplateFull | undefined;
  useEffect(() => {
    if (creating && p.kind === "server" && !p.preset.templateId && items(templates.data)[0]) {
      const t = items(templates.data)[0];
      setP((x) => ({ ...x, preset: { ...x.preset, templateId: t.id, memoryMb: t.memoryMb, cpuPercent: t.cpuPercent, diskMb: t.diskMb } }));
    }
  }, [templates.data]);
  const set = (patch: Partial<Plan>) => setP((x) => ({ ...x, ...patch }));
  const preset = (patch: Partial<Plan["preset"]>) => setP((x) => ({ ...x, preset: { ...x.preset, ...patch } }));
  const editable = (tpl?.variables || []).filter((v) => v.userEditable);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const body = {
        name: p.name, slug: p.slug || undefined, description: p.description, kind: p.kind, visibility: p.visibility, active: p.active, features: p.features,
        preset: p.kind === "server" ? p.preset : undefined, limits: p.kind === "account" ? p.limits : undefined,
        options: p.options, stock: p.stock, perCustomerMax: p.perCustomerMax, trialOnce: p.trialOnce, retentionDays: p.retentionDays,
        prices: p.prices.map(({ cycle, amount, currency, trialDays, setupFee }) => ({ cycle, amount, currency, trialDays, setupFee })),
      };
      await json(creating ? "POST" : "PUT", creating ? "/plans" : `/plans/${p.id}`, body);
      toast({ tone: "ok", title: creating ? "Plan created" : "Plan saved", description: p.name });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const vars = Object.entries(p.preset.variables || {});
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} wide title={creating ? "New plan" : `Edit ${initial.name}`} description="A plan is something you sell or give: a server with fixed resources, or an allowance a customer spends themselves.">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-section">
          <h3>Basics</h3>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Name</span>
              <input className="input" required maxLength={80} value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="Minecraft 4 GB" />
            </label>
            <label className="field">
              <span className="field__label">Kind</span>
              <select className="input select" value={p.kind} disabled={!creating} onChange={(e) => set({ kind: e.target.value as Plan["kind"] })}>
                <option value="server">Server: each subscription creates one server</option>
                <option value="account">Account: adds to what the customer can create</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span className="field__label">Description</span>
            <textarea className="input" rows={2} maxLength={600} value={p.description} onChange={(e) => set({ description: e.target.value })} placeholder="Great for a group of friends." />
          </label>
          <label className="field">
            <span className="field__label">Highlights (one per line)</span>
            <textarea className="input" rows={4} value={p.features.join("\n")} onChange={(e) => set({ features: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12) })} placeholder={"Daily backups\nDDoS protection\nInstant setup"} />
          </label>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Shown in the store</span>
              <select className="input select" value={p.visibility} onChange={(e) => set({ visibility: e.target.value as Plan["visibility"] })}>
                <option value="public">Everyone</option>
                <option value="hidden">Only people with the link</option>
                <option value="private">Nobody (give it to customers yourself)</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">Badge</span>
              <input className="input" maxLength={24} value={p.options.badge || ""} onChange={(e) => set({ options: { ...p.options, badge: e.target.value } })} placeholder="Most popular" />
            </label>
          </div>
          <div className="toggle-row">
            <div>
              <strong>On sale</strong>
              <small>Switch off to hide the plan without losing its subscribers.</small>
            </div>
            <Switch label="On sale" checked={p.active} onChange={(active) => set({ active })} />
          </div>
          <div className="toggle-row">
            <div>
              <strong>Highlight it</strong>
              <small>Draws a frame around the card.</small>
            </div>
            <Switch label="Highlight" checked={!!p.options.highlight} onChange={(highlight) => set({ options: { ...p.options, highlight } })} />
          </div>
        </div>

        {p.kind === "server" ? (
          <div className="form-section">
            <h3>The server</h3>
            <State loading={templates.loading} error={templates.error}>
              <div className="form-grid">
                <label className="field">
                  <span className="field__label">Template</span>
                  <select
                    className="input select"
                    value={p.preset.templateId || ""}
                    onChange={(e) => {
                      const t = items(templates.data).find((x) => x.id === e.target.value);
                      preset({ templateId: e.target.value, editableVariables: [], variables: {}, ...(t && creating ? { memoryMb: t.memoryMb, cpuPercent: t.cpuPercent, diskMb: t.diskMb } : {}) });
                    }}
                  >
                    {items(templates.data).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">Memory (MB)</span>
                  <input className="input" type="number" min={256} step={256} value={p.preset.memoryMb ?? ""} onChange={(e) => preset({ memoryMb: Number(e.target.value) })} />
                  <span className="field__hint">{p.preset.memoryMb ? memText(p.preset.memoryMb) : ""}</span>
                </label>
                <label className="field">
                  <span className="field__label">CPU (percent of one core)</span>
                  <input className="input" type="number" min={10} step={25} value={p.preset.cpuPercent ?? ""} onChange={(e) => preset({ cpuPercent: Number(e.target.value) })} />
                </label>
                <label className="field">
                  <span className="field__label">Disk (MB)</span>
                  <input className="input" type="number" min={256} step={1024} value={p.preset.diskMb ?? ""} onChange={(e) => preset({ diskMb: Number(e.target.value) })} />
                  <span className="field__hint">{p.preset.diskMb ? memText(p.preset.diskMb) : ""}</span>
                </label>
              </div>
              <div className="field">
                <span className="field__label">Locations</span>
                <div className="chips">
                  {locations.length === 0 ? <small className="muted">Add a node first to choose locations.</small> : null}
                  {locations.map((l) => {
                    const on = (p.preset.locations || []).includes(l);
                    return (
                      <label className="check" key={l}>
                        <input type="checkbox" checked={on} onChange={(e) => preset({ locations: e.target.checked ? [...(p.preset.locations || []), l] : (p.preset.locations || []).filter((x) => x !== l) })} />
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m3.5 8.5 3 3 6-7" />
                        </svg>
                        {l}
                      </label>
                    );
                  })}
                </div>
                <span className="field__hint">Leave all unticked to use any location. With several ticked, the buyer can choose.</span>
              </div>
              <div className="toggle-row">
                <div>
                  <strong>Buyer may name the server</strong>
                </div>
                <Switch label="Buyer may name the server" checked={p.preset.allowNameChoice !== false} onChange={(v) => preset({ allowNameChoice: v })} />
              </div>
              <div className="toggle-row">
                <div>
                  <strong>Buyer may choose the location</strong>
                  <small>When several locations are ticked.</small>
                </div>
                <Switch label="Buyer may choose the location" checked={p.preset.allowLocationChoice !== false} onChange={(v) => preset({ allowLocationChoice: v })} />
              </div>
              {editable.length ? (
                <div className="field">
                  <span className="field__label">Settings the buyer may change</span>
                  <div className="chips">
                    {editable.map((v) => {
                      const on = (p.preset.editableVariables || []).includes(v.key);
                      return (
                        <label className="check" key={v.key}>
                          <input type="checkbox" checked={on} onChange={(e) => preset({ editableVariables: e.target.checked ? [...(p.preset.editableVariables || []), v.key] : (p.preset.editableVariables || []).filter((x) => x !== v.key) })} />
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="m3.5 8.5 3 3 6-7" />
                          </svg>
                          {v.label || v.key}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="field">
                <span className="field__label">Fixed settings for every server (optional)</span>
                {vars.map(([k, v]) => (
                  <div className="form-grid" key={k} style={{ marginBottom: 6 }}>
                    <input className="input mono" value={k} readOnly aria-label="Name" />
                    <span style={{ display: "flex", gap: 6 }}>
                      <input className="input mono" value={v} aria-label={`${k} value`} onChange={(e) => preset({ variables: { ...p.preset.variables, [k]: e.target.value } })} />
                      <Button size="icon" variant="ghost" aria-label={`Remove ${k}`} onClick={() => { const next = { ...p.preset.variables }; delete next[k]; preset({ variables: next }); }}>
                        <Trash2 />
                      </Button>
                    </span>
                  </div>
                ))}
                <AddVariable onAdd={(k, v) => preset({ variables: { ...p.preset.variables, [k]: v } })} />
              </div>
            </State>
          </div>
        ) : (
          <div className="form-section">
            <h3>What this plan adds</h3>
            <Notice tone="neutral">The subscriber's limits increase by these amounts (on top of the panel defaults). Leave a field empty to add nothing to it.</Notice>
            <LimitSetEditor value={p.limits} onChange={(limits) => set({ limits })} inherit="Adds nothing" templates={items(templates.data).map((t) => ({ id: t.id, name: t.name }))} locations={locations} />
          </div>
        )}

        <div className="form-section">
          <h3>Prices</h3>
          <PriceEditor prices={p.prices} onChange={(prices) => set({ prices })} currencies={currencies} currency={currency} setCurrency={setCurrency} />
        </div>

        <div className="form-section">
          <h3>Availability</h3>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Stock</span>
              <input className="input" type="number" min={0} value={p.stock ?? ""} placeholder="Unlimited" onChange={(e) => set({ stock: e.target.value === "" ? null : Number(e.target.value) })} />
              <span className="field__hint">Most subscriptions that can exist at once.</span>
            </label>
            <label className="field">
              <span className="field__label">Per customer</span>
              <input className="input" type="number" min={1} max={1000} value={p.perCustomerMax} onChange={(e) => set({ perCustomerMax: Math.max(1, Number(e.target.value) || 1) })} />
              <span className="field__hint">How many of this plan one person may hold.</span>
            </label>
            <label className="field">
              <span className="field__label">Keep data after it ends (days)</span>
              <input className="input" type="number" min={0} max={3650} value={p.retentionDays ?? ""} placeholder="Panel default" onChange={(e) => set({ retentionDays: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
          </div>
          <div className="toggle-row">
            <div>
              <strong>One free trial per customer</strong>
              <small>A second purchase of this plan starts paying at once.</small>
            </div>
            <Switch label="One free trial per customer" checked={p.trialOnce} onChange={(trialOnce) => set({ trialOnce })} />
          </div>
          <label className="field">
            <span className="field__label">Note under the card</span>
            <input className="input" maxLength={300} value={p.options.note || ""} onChange={(e) => set({ options: { ...p.options, note: e.target.value } })} placeholder="Prices exclude VAT." />
          </label>
        </div>
        <ErrorNotice message={error} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={busy}>
            {creating ? "Create plan" : "Save plan"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Drawer>
  );
}

function AddVariable({ onAdd }: { onAdd: (k: string, v: string) => void }) {
  const [k, setK] = useState(""),
    [v, setV] = useState("");
  const ok = /^[A-Z_][A-Z0-9_]*$/.test(k);
  return (
    <div className="form-grid">
      <input className="input mono" placeholder="NAME (capitals)" value={k} onChange={(e) => setK(e.target.value.toUpperCase())} aria-label="New setting name" />
      <span style={{ display: "flex", gap: 6 }}>
        <input className="input mono" placeholder="value" value={v} onChange={(e) => setV(e.target.value)} aria-label="New setting value" />
        <Button size="sm" disabled={!ok} onClick={() => { onAdd(k, v); setK(""); setV(""); }}>
          <Plus /> Add
        </Button>
      </span>
    </div>
  );
}

export default function PlansTab({ currencies, defaultCurrency }: { currencies: string[]; defaultCurrency: string }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Plan[]>("/plans");
  const [editing, setEditing] = useState<Plan | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ tone: "ok", title: ok });
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  };
  const columns: DataColumn<Plan>[] = [
    { id: "name", header: "Plan", value: (p) => p.name, render: (p) => (<span><strong style={{ fontWeight: 550 }}>{p.name}</strong> <small className="muted">{p.kind === "server" ? "Server" : "Account"}</small></span>) },
    { id: "prices", header: "Prices", sortable: false, value: () => "", render: (p) => (p.prices.length ? <span className="chips">{p.prices.map((x) => <span className="tag" key={x.id}>{money(x.amount, x.currency)} / {x.cycle === "month" ? "mo" : x.cycle === "year" ? "yr" : x.cycle === "quarter" ? "3 mo" : "6 mo"}</span>)}</span> : <span className="muted">No price</span>) },
    { id: "subs", header: "Subscribers", value: (p) => String(p.subscribers ?? 0), render: (p) => <span className="num">{p.subscribers ?? 0}{p.pendingOrders ? <small className="muted"> +{p.pendingOrders} checking out</small> : null}</span> },
    { id: "stock", header: "Left", optional: true, value: (p) => String(p.remaining ?? ""), render: (p) => <span className="num">{p.remaining === null || p.remaining === undefined ? "∞" : p.remaining}</span> },
    { id: "visibility", header: "Shown", optional: true, value: (p) => p.visibility, render: (p) => <span className="muted">{p.visibility === "public" ? "Everyone" : p.visibility === "hidden" ? "Link only" : "Nobody"}</span> },
    { id: "status", header: "Status", value: (p) => (p.archivedAt ? "archived" : p.active ? "on" : "off"), render: (p) => p.archivedAt ? <Status tone="neutral" label="Archived" /> : <Status tone={p.active ? "ok" : "neutral"} label={p.active ? "On sale" : "Off"} /> },
    {
      id: "actions", header: "", sortable: false, align: "end", value: () => "",
      render: (p) => (
        <span className="btn-group">
          <Button size="sm" onClick={() => setEditing(p)}><Pencil /> Edit</Button>
          <Button size="icon" variant="ghost" aria-label={`Duplicate ${p.name}`} onClick={() => act(() => json("POST", `/plans/${p.id}/duplicate`), "Plan duplicated")}><Copy /></Button>
          {p.archivedAt ? (
            <Button size="icon" variant="ghost" aria-label={`Restore ${p.name}`} onClick={() => act(() => json("POST", `/plans/${p.id}/unarchive`), "Plan restored")}><ArchiveRestore /></Button>
          ) : (
            <Confirm variant="ghost" size="sm" danger={false} confirmLabel="Archive" text={`Archive ${p.name}? It disappears from the store; existing subscriptions keep running.`} onConfirm={async () => { await json("POST", `/plans/${p.id}/archive`); reload(); }}><Archive /></Confirm>
          )}
          {!p.subscribers && !p.pendingOrders ? (
            <Confirm variant="ghost" size="sm" confirmLabel="Delete" text={`Delete ${p.name}? This cannot be undone.`} onConfirm={async () => { await json("DELETE", `/plans/${p.id}`); reload(); }}><Trash2 /></Confirm>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <>
      <Card
        flush
        title="Plans"
        description="What you sell or give away."
        actions={<Button variant="primary" size="sm" onClick={() => setEditing(blank(defaultCurrency))}><Plus /> New plan</Button>}
      >
        <State loading={loading} error={error}>
          <DataTable data={items(data)} rowKey={(p) => p.id} columns={columns} empty="No plans yet. Create one to start selling." />
        </State>
      </Card>
      {editing ? <PlanForm key={editing.id || "new"} initial={editing} currencies={currencies} defaultCurrency={defaultCurrency} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} /> : null}
    </>
  );
}
