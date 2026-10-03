"use client";
import { API, items, json, request } from "@/lib/api";
import { fmtAgo, fmtDay, fmtTime } from "@/lib/format";
import { cycleLabel, money, statusLabel, statusTone, type Cycle } from "@/lib/commerce";
import { CircleAlert, CircleCheck, CircleDashed, Download, ExternalLink, Gift, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { CopyButton, Drawer, Modal } from "./feedback";
import PlansTab from "./PlanEditor";
import { Button, Card, Confirm, ErrorNotice, Notice, PageHeader, Row, SearchInput, State, Status, btn, useLoad } from "./shared";
import { useToast } from "./toast";

type Check = { id: string; label: string; ok: boolean; detail: string; blocking: boolean };
type Health = {
  provider: null | { id: string; name: string; pluginId: string }; providerOk: boolean; livemode: boolean | null; message: string; webhookUrl: string | null;
  inbox: { pending: number; stuck: number; failing: number; lastReceivedAt: string | null; oldestPendingAt: string | null };
  failedFulfilments: number; driftLast24h: number; expiredWaiting: number; problems: string[];
};
type Overview = {
  mrr: { currency: string; amount: number; text: string }[]; revenueThisMonth: { currency: string; text: string; invoices: number }[]; revenueLastMonth: { currency: string; text: string }[];
  subscriptions: Record<string, number>; trials: number; pastDue: number; newThisMonth: number; canceledThisMonth: number; churnRate: number; byPlan: { id: string; name: string; active: number }[];
};

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "plans", label: "Plans" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "invoices", label: "Invoices" },
  { id: "health", label: "Health" },
];

function OverviewTab() {
  const ov = useLoad<Overview>("/billing/overview", 30000);
  const ready = useLoad<{ ready: boolean; checks: Check[] }>("/billing/readiness");
  const health = useLoad<Health>("/billing/health", 30000);
  const settings = useLoad<{ store: { enabled: boolean } }>("/settings");
  const storeOn = settings.data?.store.enabled;
  return (
    <div className="stack">
      {health.data?.problems.length ? (
        <Notice tone="warn" title="Billing needs attention">
          <ul className="callout-list">
            {health.data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <State loading={ov.loading} error={ov.error}>
        {ov.data ? (
          <>
            <div className="kpis">
              <div className="kpi">
                <span>Monthly recurring revenue</span>
                <strong>{ov.data.mrr.length ? ov.data.mrr.map((m) => m.text).join(" · ") : "—"}</strong>
                <small>From active paid subscriptions</small>
              </div>
              <div className="kpi">
                <span>Paid this month</span>
                <strong>{ov.data.revenueThisMonth.length ? ov.data.revenueThisMonth.map((m) => m.text).join(" · ") : "—"}</strong>
                <small>{ov.data.revenueLastMonth.length ? `Last month ${ov.data.revenueLastMonth.map((m) => m.text).join(" · ")}` : "After refunds"}</small>
              </div>
              <div className="kpi">
                <span>Active subscriptions</span>
                <strong>{(ov.data.subscriptions.active || 0) + (ov.data.subscriptions.trialing || 0)}</strong>
                <small>{ov.data.trials} on trial · {ov.data.newThisMonth} new this month</small>
              </div>
              <div className="kpi">
                <span>Payments overdue</span>
                <strong>{ov.data.pastDue}</strong>
                <small>{ov.data.subscriptions.suspended || 0} suspended</small>
              </div>
              <div className="kpi">
                <span>Cancelled this month</span>
                <strong>{ov.data.canceledThisMonth}</strong>
                <small>{ov.data.churnRate}% of last month’s base</small>
              </div>
            </div>
            {ov.data.byPlan.length ? (
              <Card title="Subscribers by plan" flush>
                <DataTable
                  data={ov.data.byPlan}
                  rowKey={(p) => p.id}
                  columns={[
                    { id: "name", header: "Plan", value: (p) => p.name, render: (p) => <strong style={{ fontWeight: 500 }}>{p.name}</strong> },
                    { id: "n", header: "Subscribers", align: "end", value: (p) => String(p.active), render: (p) => <span className="num">{p.active}</span> },
                  ]}
                  empty="No subscribers yet."
                />
              </Card>
            ) : null}
          </>
        ) : null}
      </State>
      <Card title={storeOn ? "Store checklist" : "Before you open the store"} description={storeOn ? "Everything the store depends on." : "The store opens once every required item is done. Turn it on in Settings, Store."} actions={<Link href="/settings#store" className={btn("secondary", "sm")}>Store settings</Link>}>
        <State loading={ready.loading} error={ready.error}>
          <ul className="checks">
            {(ready.data?.checks || []).map((c) => (
              <li key={c.id} className={c.ok ? "ok" : c.blocking ? "no" : "soft"}>
                {c.ok ? <CircleCheck aria-hidden="true" /> : c.blocking ? <CircleAlert aria-hidden="true" /> : <CircleDashed aria-hidden="true" />}
                <span>
                  {c.label}
                  <small>{c.detail}</small>
                </span>
              </li>
            ))}
          </ul>
        </State>
      </Card>
    </div>
  );
}

function GrantDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const customers = useLoad<Row[]>("/customers?limit=100");
  const plans = useLoad<Row[]>("/plans");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [f, setF] = useState({ userId: "", planId: "", endsAt: "", note: "", serverName: "" });
  const plan = items(plans.data).find((p) => p.id === f.planId);
  async function go() {
    setBusy(true);
    setError("");
    try {
      await json("POST", "/billing/grants", { userId: f.userId, planId: f.planId, endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : undefined, note: f.note || undefined, serverName: f.serverName || undefined });
      toast({ tone: "ok", title: "Plan granted" });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Give a plan" description="No payment: the customer gets the plan for free, optionally until a date. Their server is created like a purchased one.">
      <form className="form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <label className="field">
          <span className="field__label">Customer</span>
          <select className="input select" required value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
            <option value="">Choose…</option>
            {items(customers.data).filter((c) => c.status === undefined || c.status === "active").map((c) => (
              <option key={c.id} value={c.id}>{c.email}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Plan</span>
          <select className="input select" required value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}>
            <option value="">Choose…</option>
            {items(plans.data).filter((p) => !p.archivedAt).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {plan?.kind === "server" ? (
          <label className="field">
            <span className="field__label">Server name</span>
            <input className="input" value={f.serverName} placeholder={plan.name} onChange={(e) => setF({ ...f, serverName: e.target.value })} />
          </label>
        ) : null}
        <label className="field">
          <span className="field__label">Until (optional)</span>
          <input className="input" type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />
          <span className="field__hint">Leave empty for no end date.</span>
        </label>
        <label className="field">
          <span className="field__label">Note (only you see it)</span>
          <input className="input" maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </label>
        <ErrorNotice message={error} />
        <div className="modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>Give plan</Button>
        </div>
      </form>
    </Modal>
  );
}

type SubDetail = Row & { events: Row[]; invoices: Row[]; order: Row | null };

function SubscriptionDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<SubDetail>(`/billing/admin/subscriptions/${id}`);
  const [refund, setRefund] = useState<Row | null>(null);
  const run = async (path: string, body: unknown = {}, ok = "Done") => {
    try {
      await json("POST", `/billing/admin/subscriptions/${id}/${path}`, body);
      toast({ tone: "ok", title: ok });
      reload();
      onChanged();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  };
  const s = data;
  const live = s && ["trialing", "active", "past_due"].includes(s.status);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} wide title={s ? `${s.planName}` : "Subscription"} description={s ? s.email : undefined}>
      <State loading={loading} error={error}>
        {s ? (
          <div className="stack">
            <div className="row-between">
              <span className="chips">
                <Status tone={statusTone(s.status)} label={statusLabel[s.status] || s.status} />
                {s.provider === "manual" ? <span className="tag">Complimentary</span> : <span className="tag">{s.provider}{s.livemode ? "" : " · test"}</span>}
                {s.holds?.length ? <span className="tag">On hold</span> : null}
                {s.cancelAtPeriodEnd ? <span className="tag">Ends {fmtDay(s.currentPeriodEnd)}</span> : null}
              </span>
              {s.server ? <Link className={btn("secondary", "sm")} href={`/servers/${s.server.id}`}>Open server {s.server.name}</Link> : null}
            </div>
            <dl className="dl">
              <dt>Customer</dt>
              <dd>{s.email}</dd>
              <dt>Price</dt>
              <dd>{s.provider === "manual" ? "Free" : `${s.amountText} ${cycleLabel[s.cycle as Cycle]?.toLowerCase()}`}</dd>
              {s.currentPeriodEnd ? (<><dt>{s.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt><dd>{fmtTime(s.currentPeriodEnd)}</dd></>) : null}
              {s.trialEnd ? (<><dt>Trial ends</dt><dd>{fmtTime(s.trialEnd)}</dd></>) : null}
              {s.pastDueSince ? (<><dt>Overdue since</dt><dd>{fmtTime(s.pastDueSince)}</dd></>) : null}
              {s.retentionUntil ? (<><dt>Data kept until</dt><dd>{fmtTime(s.retentionUntil)}</dd></>) : null}
              {s.manualEndsAt ? (<><dt>Ends on</dt><dd>{fmtTime(s.manualEndsAt)}</dd></>) : null}
              <dt>Server</dt>
              <dd>{s.server ? `${s.server.name}${s.server.suspendedReason ? ` · held: ${s.server.suspendedReason}` : ""}` : s.fulfilment === "none" ? "Not a server plan" : `Not created yet (${s.fulfilment})`}</dd>
              {s.providerSubscriptionId ? (<><dt>Provider id</dt><dd className="mono">{s.providerSubscriptionId} <CopyButton value={s.providerSubscriptionId} label="" /></dd></>) : null}
              {s.note ? (<><dt>Note</dt><dd>{s.note}</dd></>) : null}
            </dl>
            {s.fulfilment === "failed" ? <Notice tone="warn" title="The paid server could not be created">{s.fulfilmentError} <Button size="sm" onClick={() => run("retry-fulfilment", {}, "Trying again")}>Try again</Button></Notice> : null}
            <div className="btn-group">
              {live && !s.cancelAtPeriodEnd ? <Confirm variant="secondary" text="Cancel at the end of the paid period? The customer keeps access until then." confirmLabel="Cancel at period end" danger={false} onConfirm={() => run("cancel", { when: "period_end" }, "Will end at the period end")}>Cancel at period end</Confirm> : null}
              {live ? <Confirm text="End it right now? The server is stopped immediately and no refund is issued." confirmLabel="End now" onConfirm={() => run("cancel", { when: "now" }, "Ended")}>End now</Confirm> : null}
              {s.cancelAtPeriodEnd && live ? <Button size="sm" onClick={() => run("resume", {}, "Resumed")}>Resume</Button> : null}
              {s.provider !== "manual" && s.status !== "terminated" ? <Button size="sm" onClick={() => run("sync", {}, "Checked with the provider")}><RefreshCw /> Check with provider</Button> : null}
              {s.holds?.some((h: Row) => h.type === "admin") ? (
                <Button size="sm" onClick={() => run("hold", { on: false }, "Hold released")}>Release hold</Button>
              ) : s.server ? (
                <Confirm variant="secondary" danger={false} text="Keep the server stopped, whatever the customer pays, until you release it?" confirmLabel="Place hold" onConfirm={() => run("hold", { on: true }, "Hold placed")}>Place hold</Confirm>
              ) : null}
              {["suspended", "canceled"].includes(s.status) ? (
                <Confirm text="Delete the server and its data (a last backup is taken first if backups are on)? This cannot be undone." confirmLabel="Delete server" onConfirm={async () => { await json("POST", `/billing/admin/subscriptions/${id}/terminate`, { confirm: true }); reload(); onChanged(); }}>Delete server…</Confirm>
              ) : null}
            </div>
            {s.provider === "manual" && live ? (
              <form
                className="row-between"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget).get("endsAt") as string;
                  void run("extend", { endsAt: v ? new Date(v).toISOString() : null }, "End date changed");
                }}
              >
                <label className="field" style={{ flex: 1 }}>
                  <span className="field__label">End date</span>
                  <input className="input" name="endsAt" type="datetime-local" defaultValue={s.manualEndsAt ? new Date(new Date(s.manualEndsAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""} />
                </label>
                <Button type="submit">Change end date</Button>
              </form>
            ) : null}
            {s.status === "canceled" && s.provider === "manual" ? <Notice tone="neutral">Set a new end date (or none) above to bring this complimentary plan back.</Notice> : null}
            <Card title="Invoices" flush>
              <DataTable
                data={s.invoices}
                rowKey={(i) => i.id}
                empty="No invoices."
                columns={[
                  { id: "n", header: "Invoice", value: (i) => i.number || "", render: (i) => <span>{i.number || "—"}</span> },
                  { id: "a", header: "Amount", value: (i) => i.paidText, render: (i) => <span className="num">{i.status === "paid" ? i.paidText : i.amountText}{i.refundedText ? <small className="muted"> · {i.refundedText} refunded</small> : null}</span> },
                  { id: "s", header: "Status", value: (i) => i.status, render: (i) => <Status tone={i.status === "paid" ? "ok" : i.status === "open" ? "warn" : "neutral"} label={i.status} /> },
                  { id: "d", header: "Date", value: (i) => i.createdAt, render: (i) => <time className="muted">{fmtDay(i.paidAt || i.createdAt)}</time> },
                  { id: "x", header: "", sortable: false, align: "end", value: () => "", render: (i) => (<span className="btn-group">{i.url ? <a className={btn("ghost", "sm")} href={i.url} target="_blank" rel="noreferrer">View <ExternalLink /></a> : null}{i.refundable ? <Button size="sm" onClick={() => setRefund(i)}>Refund…</Button> : null}</span>) },
                ]}
              />
            </Card>
            <Card title="Timeline" description="Every change of state and what caused it.">
              <ul className="timeline">
                {s.events.map((e, i) => (
                  <li key={i}>
                    <time title={fmtTime(e.at)}>{fmtAgo(e.at)}</time>
                    <span>{e.from ? `${statusLabel[e.from] || e.from} → ` : ""}<strong>{statusLabel[e.to] || e.to}</strong> <small className="muted">{e.reason}</small></span>
                    <small>{e.source}{e.ref ? ` · ${e.ref}` : ""}</small>
                  </li>
                ))}
                {s.events.length === 0 ? <li><span className="muted">Nothing yet.</span></li> : null}
              </ul>
            </Card>
          </div>
        ) : null}
        {refund ? (
          <Modal open onOpenChange={(o) => !o && setRefund(null)} title="Refund" description={`Invoice ${refund.number || ""}: ${refund.paidText} paid.`}>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const amount = String(f.get("amount") || "").trim();
                const minor = amount ? Math.round(Number(amount.replace(",", ".")) * 100) : undefined;
                void run("refund", { invoiceId: refund.id, amount: minor, cancel: f.get("cancel") === "on" }, "Refund issued").then(() => setRefund(null));
              }}
            >
              <label className="field">
                <span className="field__label">Amount (empty for the whole payment)</span>
                <input className="input" name="amount" inputMode="decimal" placeholder="Everything that was paid" />
              </label>
              <label className="auth__check">
                <input type="checkbox" name="cancel" />
                <span>Also end the subscription now</span>
              </label>
              <div className="modal__actions">
                <Button onClick={() => setRefund(null)}>Cancel</Button>
                <Button type="submit" variant="danger">Refund</Button>
              </div>
            </form>
          </Modal>
        ) : null}
      </State>
    </Drawer>
  );
}

function SubscriptionsTab() {
  const [status, setStatus] = useState(""),
    [q, setQ] = useState(""),
    [open, setOpen] = useState<string | null>(null),
    [granting, setGranting] = useState(false);
  const { data, error, loading, reload } = useLoad<{ items: Row[]; counts: Record<string, number> }>(`/billing/admin/subscriptions?limit=100${status ? `&status=${status}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`, 20000);
  const columns: DataColumn<Row>[] = [
    { id: "who", header: "Customer", value: (s) => s.email, render: (s) => <span>{s.email}</span> },
    { id: "plan", header: "Plan", value: (s) => s.planName, render: (s) => <strong style={{ fontWeight: 500 }}>{s.planName}</strong> },
    { id: "status", header: "Status", value: (s) => s.status, render: (s) => <span className="chips"><Status tone={statusTone(s.status)} label={statusLabel[s.status] || s.status} />{s.fulfilment === "failed" ? <span className="tag">No server</span> : null}{s.holds?.length ? <span className="tag">Hold</span> : null}</span> },
    { id: "price", header: "Price", optional: true, value: (s) => String(s.amount), render: (s) => <span className="num">{s.provider === "manual" ? "Free" : s.amountText}</span> },
    { id: "when", header: "Renews / ends", optional: true, value: (s) => s.currentPeriodEnd || "", render: (s) => <span className="muted">{s.currentPeriodEnd ? (s.cancelAtPeriodEnd ? "Ends " : "") + fmtDay(s.currentPeriodEnd) : "—"}</span> },
    { id: "server", header: "Server", optional: true, value: (s) => s.server?.name || "", render: (s) => <span className="muted">{s.server?.name || "—"}</span> },
    { id: "open", header: "", sortable: false, align: "end", value: () => "", render: (s) => <Button size="sm" onClick={() => setOpen(s.id)}>Open</Button> },
  ];
  const counts = data?.counts || {};
  return (
    <>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <span className="chips">
          <SearchInput label="Search customers" value={q} onChange={setQ} placeholder="Search by email" />
          <select className="input select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
            <option value="">All statuses</option>
            {Object.keys(statusLabel).map((s) => (
              <option key={s} value={s}>{statusLabel[s]}{counts[s] ? ` (${counts[s]})` : ""}</option>
            ))}
          </select>
        </span>
        <Button onClick={() => setGranting(true)}><Gift /> Give a plan</Button>
      </div>
      <Card flush>
        <State loading={loading} error={error}>
          <DataTable data={items(data?.items)} rowKey={(s) => s.id} columns={columns} empty="No subscriptions match." />
        </State>
      </Card>
      {open ? <SubscriptionDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} /> : null}
      {granting ? <GrantDialog onClose={() => setGranting(false)} onDone={() => { setGranting(false); reload(); }} /> : null}
    </>
  );
}

function InvoicesTab() {
  const [status, setStatus] = useState("");
  const { data, error, loading } = useLoad<Row[]>(`/billing/invoices?limit=100${status ? `&status=${status}` : ""}`);
  return (
    <Card
      flush
      title="Invoices"
      description="A mirror of what your payment provider issued. Their dashboard has the full detail."
      actions={
        <>
          <select className="input select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
            <option value="">All</option>
            <option value="paid">Paid</option>
            <option value="open">Open</option>
            <option value="void">Void</option>
            <option value="uncollectible">Uncollectible</option>
          </select>
          <a className={btn("secondary", "sm")} href={`${API}/api/billing/invoices.csv`}><Download /> Export CSV</a>
        </>
      }
    >
      <State loading={loading} error={error}>
        <DataTable
          data={items(data)}
          rowKey={(i) => i.id}
          empty="No invoices yet."
          columns={[
            { id: "n", header: "Invoice", value: (i) => i.number || "", render: (i) => <span>{i.number || "—"}{!i.livemode ? <span className="tag" style={{ marginLeft: 6 }}>test</span> : null}</span> },
            { id: "c", header: "Customer", value: (i) => i.email || "", render: (i) => <span>{i.email || "—"}</span> },
            { id: "p", header: "Plan", optional: true, value: (i) => i.plan || "", render: (i) => <span className="muted">{i.plan || "—"}</span> },
            { id: "a", header: "Amount", value: (i) => i.paidText, render: (i) => <span className="num">{i.status === "paid" ? i.paidText : i.amountText}{i.refundedText ? <small className="muted"> · {i.refundedText} refunded</small> : null}</span> },
            { id: "s", header: "Status", value: (i) => i.status, render: (i) => <Status tone={i.status === "paid" ? "ok" : i.status === "open" ? "warn" : "neutral"} label={i.status} /> },
            { id: "d", header: "Date", value: (i) => i.createdAt, render: (i) => <time className="muted">{fmtDay(i.paidAt || i.createdAt)}</time> },
            { id: "u", header: "", sortable: false, align: "end", value: () => "", render: (i) => (i.url ? <a className={btn("ghost", "sm")} href={i.url} target="_blank" rel="noreferrer">View <ExternalLink /></a> : null) },
          ]}
        />
      </State>
    </Card>
  );
}

function HealthTab() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Health>("/billing/health", 15000);
  const events = useLoad<Row[]>("/billing/events?limit=30", 15000);
  const [checking, setChecking] = useState(false);
  const [wipe, setWipe] = useState(false);
  async function check() {
    setChecking(true);
    try {
      const r = (await json("POST", "/billing/provider/check")) as { ok: boolean; message: string };
      toast({ tone: r.ok ? "ok" : "bad", title: r.ok ? "The provider answers" : "The provider does not answer", description: r.message });
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "Check failed", description: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="stack">
      <State loading={loading} error={error}>
        {data ? (
          <>
            <Card title="Payment provider" actions={<Button size="sm" busy={checking} onClick={check}><RefreshCw /> Check now</Button>}>
              {data.provider ? (
                <dl className="dl">
                  <dt>Provider</dt>
                  <dd>{data.provider.name} <Link className="text-button" href={`/plugins`}>plugin settings</Link></dd>
                  <dt>Connection</dt>
                  <dd><Status tone={data.providerOk ? "ok" : "bad"} label={data.providerOk ? "Working" : "Not working"} /> <span className="muted">{data.message}</span></dd>
                  <dt>Mode</dt>
                  <dd>{data.livemode === null ? "Unknown" : data.livemode ? <Status tone="ok" label="Live: real money" /> : <Status tone="warn" label="Test: no real money" />}</dd>
                  <dt>Webhook address</dt>
                  <dd className="mono">{data.webhookUrl} {data.webhookUrl ? <CopyButton value={data.webhookUrl} label="Copy" /> : null}</dd>
                </dl>
              ) : (
                <Notice tone="warn">No payment provider is chosen. Enable the Stripe plugin under Plugins, then pick it in Settings, Billing.</Notice>
              )}
            </Card>
            <div className="kpis">
              <div className="kpi"><span>Events waiting</span><strong>{data.inbox.pending}</strong><small>{data.inbox.stuck ? `${data.inbox.stuck} gave up` : "Processed in the background"}</small></div>
              <div className="kpi"><span>Last event</span><strong style={{ fontSize: "calc(16px * var(--text-scale))" }}>{data.inbox.lastReceivedAt ? fmtAgo(data.inbox.lastReceivedAt) : "None yet"}</strong><small>From the provider</small></div>
              <div className="kpi"><span>Servers not created</span><strong>{data.failedFulfilments}</strong><small>Paid, still waiting for room</small></div>
              <div className="kpi"><span>Repaired in 24 h</span><strong>{data.driftLast24h}</strong><small>Missed events caught by the scheduled check</small></div>
            </div>
          </>
        ) : null}
      </State>
      <Card flush title="Recent payment events" description="Every event is stored before it is acted on, so none is lost if the panel restarts.">
        <State loading={events.loading} error={events.error}>
          <DataTable
            data={items(events.data)}
            rowKey={(e) => String(e.id)}
            empty="No events yet. Send a test event from your provider."
            columns={[
              { id: "t", header: "Type", value: (e) => e.type, render: (e) => <span className="mono">{e.type}</span> },
              { id: "r", header: "Received", value: (e) => e.receivedAt, render: (e) => <time className="muted" title={fmtTime(e.receivedAt)}>{fmtAgo(e.receivedAt)}</time> },
              { id: "s", header: "Result", value: (e) => (e.processedAt ? "done" : e.error ? "failing" : "waiting"), render: (e) => e.processedAt ? <Status tone="ok" label="Done" /> : e.error ? <Status tone="bad" label="Failing" /> : <Status tone="busy" label="Waiting" /> },
              { id: "e", header: "Detail", optional: true, value: (e) => e.error || "", render: (e) => <span className="muted">{e.error || (e.attempts > 1 ? `${e.attempts} attempts` : "")}</span> },
              { id: "x", header: "", sortable: false, align: "end", value: () => "", render: (e) => (e.error || !e.processedAt) ? <Button size="sm" onClick={async () => { await json("POST", `/billing/events/${e.id}/retry`); events.reload(); }}>Process again</Button> : null },
            ]}
          />
        </State>
      </Card>
      {data?.livemode ? (
        <Card title="Test data" description="Records made while the provider was in test mode.">
          <Button variant="danger" onClick={() => setWipe(true)}>Remove test-mode records…</Button>
          {wipe ? (
            <Modal open onOpenChange={(o) => !o && setWipe(false)} title="Remove test-mode records" description="Deletes subscriptions, orders and invoices created in test mode. Live records are never touched. Servers created by test purchases must be deleted first.">
              <form className="form" onSubmit={async (e) => { e.preventDefault(); try { const r = (await json("POST", "/billing/test-data/reset", { confirm: new FormData(e.currentTarget).get("c") })) as { removed: number }; toast({ tone: "ok", title: "Test data removed", description: `${r.removed} subscription(s)` }); setWipe(false); reload(); } catch (x) { toast({ tone: "bad", title: "Not removed", description: (x as Error).message }); } }}>
                <label className="field"><span className="field__label">Type “delete test data”</span><input className="input" name="c" required autoComplete="off" /></label>
                <div className="modal__actions"><Button onClick={() => setWipe(false)}>Cancel</Button><Button type="submit" variant="danger">Remove</Button></div>
              </form>
            </Modal>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

export default function BillingAdmin() {
  const query = useSearchParams();
  const router = useRouter();
  const tab = TABS.some((t) => t.id === query.get("tab")) ? (query.get("tab") as string) : "overview";
  const settings = useLoad<{ billing: { currencies: string[]; currency: string } }>("/settings");
  return (
    <>
      <PageHeader
        nav="billing"
        title="Billing"
        description="Plans, subscriptions and money."
        actions={
          <>
            <Link className={btn("secondary", "sm")} href="/store">Preview the store</Link>
            <Link className={btn("secondary", "sm")} href="/settings#billing">Settings</Link>
          </>
        }
      />
      <nav className="tabs-bar" aria-label="Billing sections">
        {TABS.map((t) => (
          <button key={t.id} aria-current={tab === t.id ? "page" : undefined} onClick={() => router.push(`/billing${t.id === "overview" ? "" : `?tab=${t.id}`}`)}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "overview" ? <OverviewTab /> : null}
      {tab === "plans" ? <PlansTab currencies={settings.data?.billing.currencies || ["eur"]} defaultCurrency={settings.data?.billing.currency || "eur"} /> : null}
      {tab === "subscriptions" ? <SubscriptionsTab /> : null}
      {tab === "invoices" ? <InvoicesTab /> : null}
      {tab === "health" ? <HealthTab /> : null}
    </>
  );
}
void money;void request;
