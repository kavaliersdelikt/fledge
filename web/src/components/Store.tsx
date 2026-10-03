"use client";
import { ApiError, json, request } from "@/lib/api";
import {
  CYCLES,
  cpuText,
  cycleLabel,
  cycleShort,
  memText,
  type Cycle,
  type OrderView,
  type StorePlan,
  type StoreView,
} from "@/lib/commerce";
import { fmtMb } from "@/lib/format";
import { Check, CircleCheck, CircleX, LoaderCircle, Receipt } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "./feedback";
import { Button, Empty, ErrorNotice, Notice, PageHeader, Segmented, State, btn, useLoad } from "./shared";
import { useToast } from "./toast";

/** The price a plan shows for the chosen interval; falls back to the first one it has. */
function priceFor(plan: StorePlan, cycle: Cycle) {
  return plan.prices.find((p) => p.cycle === cycle) || plan.prices[0];
}

function PlanCardView({ plan, cycle, onBuy, canBuy, free }: { plan: StorePlan; cycle: Cycle; onBuy: () => void; canBuy: boolean; free: boolean }) {
  const price = priceFor(plan, cycle);
  const unavailable = plan.soldOut || !plan.canBuyMore;
  return (
    <article className={`plan-card${plan.highlight ? " plan-card--highlight" : ""}${plan.soldOut ? " plan-card--sold" : ""}`} aria-label={plan.name}>
      <div className="plan-card__top">
        <h3>{plan.name}</h3>
        {plan.badge ? <span className="tag tag--accent">{plan.badge}</span> : null}
      </div>
      {plan.description ? <p className="plan-card__desc">{plan.description}</p> : null}
      <div className="plan-card__price">
        {plan.free || price.amount === 0 ? (
          <span className="plan-card__amount">Free</span>
        ) : (
          <>
            <span className="plan-card__amount">{price.text}</span>
            <span className="plan-card__per">/ {cycleShort[price.cycle]}</span>
            {price.perMonthText ? <span className="plan-card__sub">{price.perMonthText} per month{price.savings ? ` · save ${price.savings}%` : ""}</span> : null}
            {price.trialDays ? <span className="plan-card__sub">{price.trialDays}-day free trial</span> : null}
            {price.setupText ? <span className="plan-card__sub">+ {price.setupText} one-time setup</span> : null}
          </>
        )}
      </div>
      {plan.spec ? (
        <dl className="plan-card__spec">
          <div>
            <dt>Memory</dt>
            <dd>{memText(plan.spec.memoryMb)}</dd>
          </div>
          <div>
            <dt>CPU</dt>
            <dd>{cpuText(plan.spec.cpuPercent)}</dd>
          </div>
          <div>
            <dt>Disk</dt>
            <dd>{fmtMb(plan.spec.diskMb)}</dd>
          </div>
        </dl>
      ) : null}
      {plan.features.length ? (
        <ul className="plan-card__features">
          {plan.features.map((f) => (
            <li key={f}>
              <Check aria-hidden="true" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {plan.note ? <p className="legal">{plan.note}</p> : null}
      <div className="plan-card__foot">
        <Button variant={plan.highlight ? "primary" : "secondary"} disabled={!canBuy || unavailable} onClick={onBuy}>
          {plan.soldOut ? "Sold out" : !plan.canBuyMore ? "You have this plan" : free || plan.free ? "Get it free" : "Choose plan"}
        </Button>
        {!plan.soldOut && plan.stock !== null && plan.stock <= 5 ? <span className="plan-card__stock">Only {plan.stock} left</span> : null}
      </div>
    </article>
  );
}

function BuyDialog({ plan, cycle, view, onClose }: { plan: StorePlan; cycle: Cycle; view: StoreView; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [chosen, setChosen] = useState<Cycle>(cycle);
  const price = priceFor(plan, chosen);
  const [name, setName] = useState(plan.name);
  const locations = plan.spec?.locations || [];
  const [location, setLocation] = useState(locations.length === 1 ? locations[0] : "");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const free = plan.free || price.amount === 0;
  const needTerms = view.legal.requireTerms && !free ? true : view.legal.requireTerms;

  async function buy() {
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = { planId: plan.id, cycle: price.cycle, acceptTerms: terms };
      if (plan.spec?.allowNameChoice) body.name = name;
      if (location) body.location = location;
      const changed = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== ""));
      if (Object.keys(changed).length) body.variables = changed;
      const r = (await json("POST", "/store/checkout", body)) as { url?: string; free?: boolean; orderId: string };
      if (r.url) {
        window.location.assign(r.url);
        return;
      }
      toast({ tone: "ok", title: "Your plan is ready", description: plan.kind === "server" ? "We’re creating your server." : undefined });
      router.push(`/?order=${r.orderId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={plan.name} description={free ? "This plan is free." : "You pay on the next page. Your card details never reach this panel."}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void buy();
        }}
      >
        {plan.prices.length > 1 ? (
          <Segmented<Cycle>
            label="Billing interval"
            value={chosen}
            onChange={setChosen}
            options={plan.prices.map((p) => ({ value: p.cycle, label: `${cycleLabel[p.cycle]} · ${p.text}` }))}
          />
        ) : null}
        {plan.spec?.allowNameChoice ? (
          <label className="field">
            <span className="field__label">Server name</span>
            <input className="input" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
          </label>
        ) : null}
        {plan.spec && plan.spec.allowLocationChoice && locations.length > 1 ? (
          <label className="field">
            <span className="field__label">Location</span>
            <select className="input select" value={location} required onChange={(e) => setLocation(e.target.value)}>
              <option value="">Choose a location</option>
              {locations.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {plan.spec?.variables.map((v) => (
          <label className="field" key={v.key}>
            <span className="field__label">{v.label}</span>
            {v.type === "select" && v.options ? (
              <select className="input select" value={vars[v.key] ?? ""} onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })}>
                <option value="">Default</option>
                {v.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                type={v.type === "number" ? "number" : "text"}
                min={v.min}
                max={v.max}
                value={vars[v.key] ?? ""}
                placeholder="Default"
                onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })}
              />
            )}
            {v.description ? <span className="field__hint">{v.description}</span> : null}
          </label>
        ))}
        {free ? null : (
          <div className="price-total" aria-live="polite">
            <span>
              {cycleLabel[price.cycle]}
              {price.trialDays ? ` · starts after a ${price.trialDays}-day trial` : ""}
              {price.setupText ? ` · plus ${price.setupText} setup` : ""}
            </span>
            <strong>{price.text}</strong>
          </div>
        )}
        {needTerms ? (
          <label className="auth__check">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} required />
            <span>
              I accept the{" "}
              <a href={view.legal.termsUrl} target="_blank" rel="noreferrer">
                terms
              </a>{" "}
              and have read the{" "}
              <a href={view.legal.privacyUrl} target="_blank" rel="noreferrer">
                privacy policy
              </a>
              .
            </span>
          </label>
        ) : null}
        {view.legal.withdrawalNotice && !free ? <p className="legal">{view.legal.withdrawalNotice}</p> : null}
        {view.legal.taxNote && !free ? <p className="legal">{view.legal.taxNote}</p> : null}
        <ErrorNotice message={error} />
        <div className="modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={needTerms && !terms}>
            {free ? "Get it" : "Continue to payment"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** What the customer sees after paying: waits until the payment is confirmed and the server exists. */
export function OrderReturn({ id }: { id: string }) {
  const [order, setOrder] = useState<OrderView | null>(null),
    [error, setError] = useState(""),
    [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    let live = true;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const o = await request<OrderView>(`/store/orders/${id}`);
        if (!live) return;
        setOrder(o);
        setError("");
        const done = (o.status === "paid" && (o.server || o.subscriptionStatus === null || o.fulfilment === "none" || o.fulfilment === "done")) || o.status === "expired" || o.status === "failed" || o.status === "canceled";
        if (done) return;
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) {
          setError("We can’t find that order.");
          return;
        }
      }
      if (Date.now() - started > 10 * 60_000) return setGaveUp(true);
      timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id]);

  const paid = order?.status === "paid";
  const settingUp = paid && !order?.server && order?.fulfilment !== "none";
  const bad = order && ["expired", "failed", "canceled"].includes(order.status);
  return (
    <div className="order-status" role="status" aria-live="polite">
      <div className={`order-status__icon${paid && order?.server ? " order-status__icon--ok" : bad ? " order-status__icon--bad" : ""}`}>
        {paid && order?.server ? <CircleCheck /> : bad ? <CircleX /> : <LoaderCircle className="spin" />}
      </div>
      {error ? (
        <>
          <h1>Order not found</h1>
          <p>{error}</p>
        </>
      ) : !order ? (
        <h1>Checking your order…</h1>
      ) : bad ? (
        <>
          <h1>{order.status === "expired" ? "That checkout expired" : "That checkout didn’t go through"}</h1>
          <p>No payment was taken. You can start again whenever you like.</p>
        </>
      ) : paid && order.server ? (
        <>
          <h1>Your server is ready</h1>
          <p>
            Thank you! <strong>{order.server.name}</strong> is starting up.
          </p>
        </>
      ) : paid && order.fulfilment === "failed" ? (
        <>
          <h1>Payment received</h1>
          <p>We’re still setting up your server. This can take a few minutes; you don’t need to do anything. We’ll email you as soon as it’s ready.</p>
        </>
      ) : paid ? (
        <>
          <h1>Payment received</h1>
          <p>{settingUp ? "Setting up your server…" : `Your ${order.planName} plan is active.`}</p>
        </>
      ) : (
        <>
          <h1>Waiting for your payment</h1>
          <p>Complete the payment on the payment page. This page updates by itself.</p>
          {order.checkoutUrl ? (
            <a className={btn("secondary")} href={order.checkoutUrl}>
              Go back to the payment page
            </a>
          ) : null}
        </>
      )}
      {gaveUp ? <Notice tone="warn">This is taking longer than usual. Check Billing in a few minutes.</Notice> : null}
      <div className="btn-group">
        {order?.server ? (
          <Link className={btn("primary")} href={`/servers/${order.server.id}`}>
            Open the server
          </Link>
        ) : null}
        <Link className={btn("secondary")} href="/billing">
          <Receipt /> Billing
        </Link>
        <Link className={btn("ghost")} href="/store">
          Back to the store
        </Link>
      </div>
    </div>
  );
}

export default function Store() {
  const query = useSearchParams();
  const order = query.get("order");
  const { data, error, loading } = useLoad<StoreView>(order ? null : "/store");
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [buying, setBuying] = useState<StorePlan | null>(null);
  const available = useMemo(() => CYCLES.filter((c) => data?.plans.some((p) => p.prices.some((x) => x.cycle === c))), [data]);
  if (order) return <OrderReturn id={order} />;
  const active: Cycle = cycle && available.includes(cycle) ? cycle : available.includes(data?.defaultInterval || "month") ? data?.defaultInterval || "month" : available[0] || "month";
  const best = Math.max(0, ...(data?.plans.flatMap((p) => p.prices.filter((x) => x.cycle === "year").map((x) => x.savings)) || []));
  return (
    <>
      <PageHeader nav="store" title={data?.title || "Store"} description={data?.intro || "Pick a plan. You can change or cancel it any time."} />
      {query.get("canceled") ? <Notice tone="neutral">Checkout cancelled. Nothing was charged.</Notice> : null}
      <State loading={loading} error={error}>
        {data ? (
          <>
            {!data.canBuy && data.reason ? <Notice tone="warn">{data.reason}</Notice> : null}
            {data.plans.length === 0 ? (
              <Empty title="Nothing for sale yet">The plans will show up here.</Empty>
            ) : (
              <>
                {available.length > 1 ? (
                  <div className="store__bar">
                    <Segmented<Cycle>
                      label="Billing interval"
                      value={active}
                      onChange={setCycle}
                      options={available.map((c) => ({ value: c, label: c === "year" && best ? `${cycleLabel[c]} · save up to ${best}%` : cycleLabel[c] }))}
                    />
                    {data.activeSubscriptions ? (
                      <Link className={btn("ghost")} href="/billing">
                        Your subscriptions ({data.activeSubscriptions})
                      </Link>
                    ) : null}
                  </div>
                ) : null}
                <div className="plans">
                  {data.plans.map((p) => (
                    <PlanCardView key={p.id} plan={p} cycle={active} canBuy={data.canBuy || (data.freeOnly === true && p.free)} free={!!data.freeOnly} onBuy={() => setBuying(p)} />
                  ))}
                </div>
              </>
            )}
            {data.legal.companyName ? (
              <p className="legal" style={{ marginTop: 22 }}>
                Sold by {data.legal.companyName}
                {data.legal.supportUrl ? (
                  <>
                    {" · "}
                    <a href={data.legal.supportUrl} target="_blank" rel="noreferrer">
                      Support
                    </a>
                  </>
                ) : null}
                {data.legal.termsUrl ? (
                  <>
                    {" · "}
                    <a href={data.legal.termsUrl} target="_blank" rel="noreferrer">
                      Terms
                    </a>
                  </>
                ) : null}
                {data.legal.privacyUrl ? (
                  <>
                    {" · "}
                    <a href={data.legal.privacyUrl} target="_blank" rel="noreferrer">
                      Privacy
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {buying ? <BuyDialog plan={buying} cycle={active} view={data} onClose={() => setBuying(null)} /> : null}
          </>
        ) : null}
      </State>
    </>
  );
}
