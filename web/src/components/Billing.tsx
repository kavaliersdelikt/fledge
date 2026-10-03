"use client";
import { json, request } from "@/lib/api";
import { fmtDay } from "@/lib/format";
import { cycleLabel, statusLabel, statusTone, type BillingView, type Cycle, type MySubscription, type StorePlan, type StoreView } from "@/lib/commerce";
import { CreditCard, ExternalLink, Server } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Modal } from "./feedback";
import { Button, Card, Confirm, Empty, ErrorNotice, Notice, PageHeader, State, Status, btn, useLoad } from "./shared";
import { useToast } from "./toast";

type Preview = { from: { plan: string; cycle: string; amountText: string }; to: { plan: string; cycle: string; amountText: string }; prorated: boolean; restart: boolean; smaller: boolean; note: string };

function ChangePlan({ sub, onClose, onDone }: { sub: MySubscription; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const store = useLoad<StoreView>("/store");
  const options = (store.data?.plans || []).filter((p) => p.kind === sub.kind).flatMap((p) => p.prices.filter((x) => x.currency === sub.currency).map((x) => ({ plan: p, price: x })));
  const [pick, setPick] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const chosen = options.find((o) => `${o.plan.id}:${o.price.cycle}` === pick);
  useEffect(() => {
    setPreview(null);
    setError("");
    if (!chosen) return;
    if (chosen.plan.id === sub.planId && chosen.price.cycle === sub.cycle) {
      setError("That is your current plan.");
      return;
    }
    let live = true;
    request<Preview>(`/billing/preview-change?subscriptionId=${sub.id}&planId=${chosen.plan.id}&cycle=${chosen.price.cycle}`)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [pick]);
  async function apply() {
    if (!chosen) return;
    setBusy(true);
    try {
      await json("POST", `/billing/subscriptions/${sub.id}/change`, { planId: chosen.plan.id, cycle: chosen.price.cycle });
      toast({ tone: "ok", title: "Plan changed", description: chosen.plan.name });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Change plan" description={`You are on ${sub.planName}, ${sub.intervalText}.`}>
      <State loading={store.loading} error={store.error}>
        <div className="form">
          <label className="field">
            <span className="field__label">New plan</span>
            <select className="input select" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={`${o.plan.id}:${o.price.cycle}`} value={`${o.plan.id}:${o.price.cycle}`}>
                  {o.plan.name} · {cycleLabel[o.price.cycle as Cycle]} · {o.price.text}
                </option>
              ))}
            </select>
          </label>
          {preview ? (
            <Notice tone="neutral" title={`${preview.from.plan} (${preview.from.amountText}) → ${preview.to.plan} (${preview.to.amountText})`}>
              {preview.prorated ? preview.note : null}
              {preview.restart ? " Your server restarts to apply the new size." : ""}
              {preview.smaller ? " The server gets smaller; make sure your files fit." : ""}
            </Notice>
          ) : null}
          <ErrorNotice message={error} />
          <div className="modal__actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={!preview} onClick={apply}>
              Change plan
            </Button>
          </div>
        </div>
      </State>
    </Modal>
  );
}

function SubscriptionCard({ sub, billing, reload }: { sub: MySubscription; billing: BillingView; reload: () => void }) {
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const ended = sub.status === "canceled" || sub.status === "terminated";
  async function portal() {
    setBusy(true);
    try {
      const r = (await json("POST", "/billing/portal")) as { url: string };
      window.location.assign(r.url);
    } catch (e) {
      toast({ tone: "bad", title: "Can’t open the billing page", description: (e as Error).message });
      setBusy(false);
    }
  }
  const act = async (path: string, body?: unknown, ok?: string) => {
    try {
      await json("POST", `/billing/subscriptions/${sub.id}/${path}`, body);
      if (ok) toast({ tone: "ok", title: ok });
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  };
  return (
    <article className="sub" aria-label={sub.planName}>
      <div className="sub__head">
        <div className="sub__title">
          <h3>{sub.planName}</h3>
          <Status tone={statusTone(sub.status)} label={statusLabel[sub.status] || sub.status} />
          {sub.comped ? <span className="tag">Included</span> : null}
        </div>
        {sub.server ? (
          <Link className={btn("secondary", "sm")} href={`/servers/${sub.server.id}`}>
            <Server /> {sub.server.name}
          </Link>
        ) : null}
      </div>
      {!sub.comped || sub.endsAt || (ended && sub.retentionUntil && sub.server) ? (
      <div className="sub__meta">
        {sub.comped ? null : (
          <span>
            <strong>{sub.amountText}</strong> {sub.intervalText}
          </span>
        )}
        {sub.status === "trialing" && sub.trialEnd ? <span>Trial ends <strong>{fmtDay(sub.trialEnd)}</strong></span> : null}
        {(sub.status === "active" || sub.status === "past_due") && sub.currentPeriodEnd && !sub.cancelAtPeriodEnd && !sub.comped ? <span>Renews <strong>{fmtDay(sub.currentPeriodEnd)}</strong></span> : null}
        {sub.cancelAtPeriodEnd && sub.endsAt ? <span>Ends <strong>{fmtDay(sub.endsAt)}</strong></span> : null}
        {sub.comped && sub.endsAt ? <span>Until <strong>{fmtDay(sub.endsAt)}</strong></span> : null}
        {ended && sub.retentionUntil && sub.server ? <span>Data kept until <strong>{fmtDay(sub.retentionUntil)}</strong></span> : null}
      </div>
      ) : null}
      {sub.status === "past_due" ? (
        <Notice className="sub__banner" tone="warn" title="Your last payment failed" action={billing.portal ? <Button size="sm" busy={busy} onClick={portal}>Update payment method</Button> : undefined}>
          {sub.suspendAt ? `Pay by ${fmtDay(sub.suspendAt)} so your server keeps running.` : "Please update your payment method."}
        </Notice>
      ) : null}
      {sub.status === "suspended" ? (
        <Notice className="sub__banner" tone="bad" title="This server is suspended" action={billing.portal ? <Button size="sm" variant="primary" busy={busy} onClick={portal}>Pay now</Button> : undefined}>
          The payment is overdue. Your files are safe; pay the open invoice and the server starts again by itself.
        </Notice>
      ) : null}
      {sub.status === "canceled" ? (
        <Notice className="sub__banner" tone="neutral" title="This subscription has ended" action={<Link className={btn("secondary", "sm")} href="/store">Subscribe again</Link>}>
          {sub.retentionUntil && sub.server ? `The server is stopped. Subscribe again before ${fmtDay(sub.retentionUntil)} to keep its data.` : "The server is stopped."}
        </Notice>
      ) : null}
      {sub.hold ? (
        <Notice className="sub__banner" tone="warn" title="On hold">
          Your provider has paused this server. Contact support if you don’t know why.
        </Notice>
      ) : null}
      {sub.fulfilment === "failed" || (sub.fulfilment === "pending" && sub.kind === "server") ? (
        <Notice className="sub__banner" tone="busy" title="We’re setting up your server">
          Your payment went through. We keep trying and will email you as soon as the server is ready.
        </Notice>
      ) : null}
      {!ended && (sub.can.cancel || sub.can.resume || sub.can.change || billing.portal) ? (
        <div className="sub__actions">
          {sub.can.change ? <Button size="sm" onClick={() => setChanging(true)}>Change plan</Button> : null}
          {billing.portal && !sub.comped ? (
            <Button size="sm" busy={busy} onClick={portal}>
              <CreditCard /> Payment method & invoices
            </Button>
          ) : null}
          {sub.can.resume ? <Button size="sm" variant="primary" onClick={() => act("resume", {}, "Subscription will continue")}>Keep my subscription</Button> : null}
          {sub.can.cancel ? (
            <Confirm
              variant="ghost"
              text={billing.cancelNow ? `Cancel ${sub.planName}? It ends at the end of the paid period.` : `Cancel ${sub.planName}? You keep it until ${sub.currentPeriodEnd ? fmtDay(sub.currentPeriodEnd) : "the end of the paid period"}.`}
              confirmLabel="Cancel subscription"
              onConfirm={async () => {
                await json("POST", `/billing/subscriptions/${sub.id}/cancel`, {});
                toast({ tone: "ok", title: "Subscription will end", description: sub.currentPeriodEnd ? `Until ${fmtDay(sub.currentPeriodEnd)}` : undefined });
                reload();
              }}
            >
              Cancel subscription
            </Confirm>
          ) : null}
        </div>
      ) : null}
      {changing ? (
        <ChangePlan
          sub={sub}
          onClose={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            reload();
          }}
        />
      ) : null}
    </article>
  );
}

export default function Billing() {
  const { data, error, loading, reload } = useLoad<BillingView>("/billing");
  const columns: DataColumn<BillingView["invoices"][number]>[] = [
    { id: "number", header: "Invoice", value: (i) => i.number || "", render: (i) => <strong style={{ fontWeight: 500 }}>{i.number || "—"}</strong> },
    { id: "plan", header: "Plan", optional: true, value: (i) => i.plan || "", render: (i) => <span className="muted">{i.plan || "—"}</span> },
    { id: "amount", header: "Amount", value: (i) => i.paidText, render: (i) => <span className="num">{i.status === "paid" ? i.paidText : i.amountText}{i.refundedText ? <small className="muted"> · {i.refundedText} refunded</small> : null}</span> },
    { id: "status", header: "Status", value: (i) => i.status, render: (i) => <Status tone={i.status === "paid" ? "ok" : i.status === "open" ? "warn" : "neutral"} label={i.status === "paid" ? "Paid" : i.status === "open" ? "Open" : i.status} /> },
    { id: "date", header: "Date", value: (i) => i.createdAt, render: (i) => <time className="muted">{fmtDay(i.paidAt || i.createdAt)}</time> },
    { id: "open", header: "", sortable: false, align: "end", value: () => "", render: (i) => (i.url ? <a className={btn("ghost", "sm")} href={i.url} target="_blank" rel="noreferrer">View <ExternalLink /></a> : null) },
  ];
  return (
    <>
      <PageHeader nav="billing" title="Billing" description="Your subscriptions, payment details and invoices." />
      <State loading={loading} error={error}>
        {data ? (
          <div className="stack">
            {data.subscriptions.length === 0 ? (
              <Empty title="No subscriptions yet" action={data.enabled ? <Link className={btn("primary")} href="/store">Browse the store</Link> : undefined}>
                When you buy a plan, it shows up here.
              </Empty>
            ) : (
              <div className="subs">
                {data.subscriptions.map((s) => (
                  <SubscriptionCard key={s.id} sub={s} billing={data} reload={reload} />
                ))}
              </div>
            )}
            {data.invoices.length ? (
              <Card title="Invoices" flush>
                <DataTable data={data.invoices} rowKey={(i) => i.id} columns={columns} empty="No invoices yet." />
              </Card>
            ) : null}
          </div>
        ) : null}
      </State>
    </>
  );
}
void (null as unknown as StorePlan);
