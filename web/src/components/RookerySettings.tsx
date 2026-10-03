"use client";
import { items, json } from "@/lib/api";
import { fmtAgo, fmtTime } from "@/lib/format";
import { CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DataTable from "./DataTable";
import { Line, Num, Toggle, useSave } from "./AdminSettings";
import { LimitSetEditor, type LimitSet } from "./LimitsUI";
import Link from "next/link";
import { Button, Card, ErrorNotice, Notice, Row, Skeleton, State, Status, btn, useLoad } from "./shared";
import { useToast } from "./toast";

type Raw = Record<string, any>;
type All = { signup: Raw; selfService: Raw; limits: Raw; billing: Raw; store: Raw; email: Raw };

function Txt({ label, hint, value, onChange, placeholder, mono, type = "text", rows }: { label: string; hint?: ReactNode; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: string; rows?: number }) {
  return (
    <Line label={label} hint={hint}>
      {rows ? (
        <textarea className={`input${mono ? " mono" : ""}`} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={`input${mono ? " mono" : ""}`} type={type} value={value} placeholder={placeholder} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      )}
    </Line>
  );
}
function Sel({ label, hint, value, onChange, options }: { label: string; hint?: ReactNode; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <Line label={label} hint={hint}>
      <select className="input select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Line>
  );
}
const lines = (t: string) => t.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

/** A settings card that edits one section and saves it as a whole. */
function useSection<T extends Raw>(section: keyof All, value: T, reload: () => void) {
  const [v, setV] = useState<T>({ ...value });
  useEffect(() => setV({ ...value }), [value]);
  const set = (patch: Partial<T>) => setV((p) => ({ ...p, ...patch }));
  const { busy, error, save } = useSave(section, reload);
  return { v, set, busy, error, save };
}

function Actions({ busy, error }: { busy: boolean; error: string }) {
  return (
    <>
      <ErrorNotice message={error} />
      <div className="form__actions">
        <Button type="submit" variant="primary" busy={busy}>
          Save
        </Button>
      </div>
    </>
  );
}

// ---------- Sign-up ----------
function SignupCard({ value, reload, email }: { value: Raw; reload: () => void; email: boolean }) {
  const { v, set, busy, error, save } = useSection("signup", value, reload);
  const plans = useLoad<Row[]>("/plans");
  const invites = useLoad<Row[]>(v.mode === "invite" ? "/signup/invites" : null);
  const pending = useLoad<Row[]>("/signup/pending");
  const [domains, setDomains] = useState({ allowed: (value.allowedDomains || []).join("\n"), blocked: (value.blockedDomains || []).join("\n") });
  useEffect(() => setDomains({ allowed: (value.allowedDomains || []).join("\n"), blocked: (value.blockedDomains || []).join("\n") }), [value]);
  const [secret, setSecret] = useState("");
  const toast = useToast();
  const [code, setCode] = useState<{ code: string; link: string } | null>(null);
  return (
    <Card id="signup" title="Sign-up" description="Let people create their own account. Off by default." actions={<Status value={v.mode !== "off" ? "active" : "stopped"} label={v.mode === "off" ? "Off" : v.mode === "open" ? "Open" : v.mode === "approval" ? "With approval" : "Invite only"} />}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ ...v, allowedDomains: lines(domains.allowed), blockedDomains: lines(domains.blocked), captchaSecret: secret || undefined }, "Sign-up settings saved");
        }}
      >
        {!email && v.mode !== "off" ? <Notice tone="warn">Sign-up needs working email to send confirmation links. Set it up under Email first; until then sign-up stays unavailable.</Notice> : null}
        <Sel
          label="Who can sign up"
          value={v.mode}
          onChange={(mode) => set({ mode })}
          options={[
            ["off", "Nobody: administrators create accounts"],
            ["open", "Anyone with a confirmed email address"],
            ["approval", "Anyone, after an administrator approves them"],
            ["invite", "Only people with an invitation code"],
          ]}
          hint="Every new account is a customer. It cannot do anything until the email address is confirmed."
        />
        {v.mode !== "off" ? (
          <>
            <div className="form-grid">
              <Sel label="Bot protection" value={v.captchaProvider} onChange={(captchaProvider) => set({ captchaProvider })} options={[["none", "None (rate limits and verification only)"], ["turnstile", "Cloudflare Turnstile"], ["hcaptcha", "hCaptcha"]]} />
              <Num label="Minimum password length" value={v.minPasswordLength} min={12} max={128} onChange={(minPasswordLength) => set({ minPasswordLength })} />
            </div>
            {v.captchaProvider !== "none" ? (
              <div className="form-grid">
                <Txt label="Site key" value={v.captchaSiteKey} onChange={(captchaSiteKey) => set({ captchaSiteKey })} mono />
                <Txt label="Secret key" type="password" value={secret} onChange={setSecret} placeholder={value.captchaSecretSet ? "••••••••••••" : ""} hint={value.captchaSecretSet ? "A secret is saved. Leave empty to keep it." : undefined} mono />
              </div>
            ) : null}
            <Toggle label="Reject common passwords" hint="Turns away passwords that appear on breach lists, repeat a pattern or contain the email address." checked={v.rejectCommonPasswords} onChange={(rejectCommonPasswords) => set({ rejectCommonPasswords })} />
            <Toggle label="Reject throw-away email addresses" hint="A built-in list of disposable mailbox providers." checked={v.blockDisposable} onChange={(blockDisposable) => set({ blockDisposable })} />
            <div className="form-grid">
              <Txt label="Only these email domains (optional)" rows={3} mono value={domains.allowed} onChange={(allowed) => setDomains({ ...domains, allowed })} placeholder={"example.edu"} hint="One per line. Empty allows every domain." />
              <Txt label="Never these email domains" rows={3} mono value={domains.blocked} onChange={(blocked) => setDomains({ ...domains, blocked })} placeholder={"spam.example"} hint="Sub-domains are included." />
            </div>
            <div className="form-grid">
              <Num label="Sign-ups per address and hour" value={v.perIpPerHour} min={1} max={1000} onChange={(perIpPerHour) => set({ perIpPerHour })} hint="From one network address." />
              <Num label="Attempts per email and day" value={v.perEmailPerDay} min={1} max={100} onChange={(perEmailPerDay) => set({ perEmailPerDay })} />
              <Num label="Sign-ups per hour overall" value={v.globalPerHour} min={1} max={100000} onChange={(globalPerHour) => set({ globalPerHour })} hint="Above this, sign-up pauses itself and you are told." />
              <Num label="Delete unconfirmed accounts after (days)" value={v.unverifiedDays} min={1} max={365} onChange={(unverifiedDays) => set({ unverifiedDays })} />
            </div>
            <Toggle label="Require terms" hint="People must tick a box; the version is recorded with a time." checked={v.requireTerms} onChange={(requireTerms) => set({ requireTerms })} />
            {v.requireTerms ? (
              <div className="form-grid">
                <Txt label="Terms address" value={v.termsUrl} onChange={(termsUrl) => set({ termsUrl })} placeholder="https://example.com/terms" />
                <Txt label="Privacy address" value={v.privacyUrl} onChange={(privacyUrl) => set({ privacyUrl })} placeholder="https://example.com/privacy" />
                <Txt label="Terms version" value={v.termsVersion} onChange={(termsVersion) => set({ termsVersion })} hint="Change it when your terms change." />
              </div>
            ) : null}
            <Line label="Start new accounts with this free plan" hint="Optional. A free plan from Billing, Plans, for example a small starter server or an allowance.">
              <select className="input select" value={v.defaultPlanSlug} onChange={(e) => set({ defaultPlanSlug: e.target.value })}>
                <option value="">None</option>
                {items(plans.data).filter((p) => !p.archivedAt && p.prices?.every((x: Row) => x.amount === 0) && p.prices?.length).map((p) => (
                  <option key={p.id} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Line>
            <Toggle label="Send a welcome email" checked={v.welcomeEmail} onChange={(welcomeEmail) => set({ welcomeEmail })} />
            <Toggle label="Tell administrators when someone waits for approval" checked={v.notifyAdmins} onChange={(notifyAdmins) => set({ notifyAdmins })} />
          </>
        ) : null}
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>Accounts</h3>
          <Toggle label="People may change their email address" hint="The new address has to be confirmed; the old one is told." checked={v.allowEmailChange} onChange={(allowEmailChange) => set({ allowEmailChange })} />
          <Toggle label="People may download their data" checked={v.allowDataExport} onChange={(allowDataExport) => set({ allowDataExport })} />
          <Toggle label="People may delete their account" hint="Only without servers or active subscriptions. Personal data is removed after the waiting time; invoices stay, anonymised." checked={v.allowAccountDeletion} onChange={(allowAccountDeletion) => set({ allowAccountDeletion })} />
          {v.allowAccountDeletion ? <Num label="Waiting time before deletion (days)" value={v.deletionGraceDays} min={0} max={90} onChange={(deletionGraceDays) => set({ deletionGraceDays })} /> : null}
        </fieldset>
        <Actions busy={busy} error={error} />
      </form>
      {(pending.data || []).length ? (
        <>
          <hr className="rule" />
          <p className="muted small">{pending.data!.length} account(s) wait for confirmation or approval. Manage them under Customers.</p>
        </>
      ) : null}
      {v.mode === "invite" ? (
        <>
          <hr className="rule" />
          <h3 style={{ fontSize: "calc(14px * var(--text-scale))", marginBottom: 8 }}>Invitation codes</h3>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                const r = (await json("POST", "/signup/invites", { email: f.get("email") || undefined, note: f.get("note") || undefined, maxUses: Number(f.get("uses") || 1), expiresInDays: Number(f.get("days") || 14) })) as { code: string; link: string };
                setCode(r);
                invites.reload();
              } catch (x) {
                toast({ tone: "bad", title: "Could not create the invitation", description: (x as Error).message });
              }
            }}
          >
            <div className="form-grid">
              <label className="field"><span className="field__label">For this address (optional)</span><input className="input" name="email" type="email" /></label>
              <label className="field"><span className="field__label">Note</span><input className="input" name="note" maxLength={200} /></label>
              <label className="field"><span className="field__label">Can be used</span><input className="input" name="uses" type="number" min={1} max={10000} defaultValue={1} /></label>
              <label className="field"><span className="field__label">Valid for (days)</span><input className="input" name="days" type="number" min={1} max={365} defaultValue={14} /></label>
            </div>
            <div className="form__actions"><Button type="submit">Create invitation</Button></div>
          </form>
          {code ? (
            <Notice tone="ok" title="Invitation created: copy it now, it is not shown again">
              <div className="mono" style={{ wordBreak: "break-all" }}>{code.link}</div>
              <div className="muted small">Code: {code.code}</div>
            </Notice>
          ) : null}
          <DataTable
            data={items(invites.data)}
            rowKey={(i) => i.id}
            empty="No invitations."
            columns={[
              { id: "n", header: "For", value: (i) => i.email || i.note || "", render: (i) => <span>{i.email || i.note || "Anyone with the code"}</span> },
              { id: "u", header: "Used", value: (i) => String(i.uses), render: (i) => <span className="num">{i.uses} / {i.maxUses}</span> },
              { id: "e", header: "Expires", value: (i) => i.expiresAt, render: (i) => <time className="muted" title={fmtTime(i.expiresAt)}>{fmtAgo(i.expiresAt)}</time> },
              { id: "x", header: "", sortable: false, align: "end", value: () => "", render: (i) => <Button size="sm" variant="ghost" onClick={async () => { await json("DELETE", `/signup/invites/${i.id}`); invites.reload(); }}>Revoke</Button> },
            ]}
          />
        </>
      ) : null}
    </Card>
  );
}

// ---------- Self-service ----------
function SelfServiceCard({ value, reload }: { value: Raw; reload: () => void }) {
  const { v, set, busy, error, save } = useSection("selfService", value, reload);
  const toast = useToast();
  const templates = useLoad<Row[]>("/templates");
  const nodes = useLoad<Row[]>("/nodes");
  const locations = useMemo(() => [...new Set(items(nodes.data).map((n) => n.location as string))].sort(), [nodes.data]);
  const [released, setReleased] = useState<Record<string, boolean>>({});
  const flip = async (t: Row, on: boolean) => {
    setReleased((r) => ({ ...r, [t.id]: on }));
    try {
      await json("PUT", `/templates/${t.id}/store`, { customerVisible: on, customerDescription: t.customerDescription || "" });
      templates.reload();
    } catch (e) {
      setReleased((r) => ({ ...r, [t.id]: !on }));
      toast({ tone: "bad", title: "Not saved", description: (e as Error).message });
    }
  };
  return (
    <Card id="self-service" title="Customers creating servers" description="Let customers create (and delete) servers themselves, within their limits." actions={<Status value={v.mode !== "off" ? "active" : "stopped"} label={v.mode === "off" ? "Off" : v.mode === "presets" ? "Plans only" : "Free choice"} />}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save(v, "Saved"); }}>
        <Sel
          label="What customers can do"
          value={v.mode}
          onChange={(mode) => set({ mode })}
          options={[
            ["off", "Nothing: only administrators create servers"],
            ["presets", "Get servers from plans (free plans without payment, paid ones through the store)"],
            ["custom", "Also create servers freely within their limits"],
          ]}
          hint="Free choice uses the limits under Limits. Without limits set, customers could use as much as the nodes have."
        />
        {v.mode !== "off" ? (
          <>
            <Toggle label="Customers may delete their own servers" checked={v.allowDelete} onChange={(allowDelete) => set({ allowDelete })} />
            {v.allowDelete ? (
              <>
                <Num label="Keep a deleted server for (hours)" hint="During this time the server is stopped and can be restored. 0 deletes immediately." value={v.deleteCoolingHours} min={0} max={720} onChange={(deleteCoolingHours) => set({ deleteCoolingHours })} />
                <Toggle label="Take a backup first (when backups are on)" checked={v.backupBeforeDelete} onChange={(backupBeforeDelete) => set({ backupBeforeDelete })} />
              </>
            ) : null}
            <Toggle label="Require a confirmed email address" hint="Accounts you create yourself always count as confirmed." checked={v.requireVerifiedEmail} onChange={(requireVerifiedEmail) => set({ requireVerifiedEmail })} />
            <Num label="Servers one customer can create per hour" value={v.createsPerHour} min={1} max={1000} onChange={(createsPerHour) => set({ createsPerHour })} />
            <Line label="Locations customers may use" hint="Leave all unticked for every location. A customer's plan can narrow this further.">
              <div className="chips">
                {locations.map((l) => (
                  <label className="check" key={l}>
                    <input type="checkbox" checked={(v.allowedLocations || []).includes(l)} onChange={(e) => set({ allowedLocations: e.target.checked ? [...(v.allowedLocations || []), l] : (v.allowedLocations || []).filter((x: string) => x !== l) })} />
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
                    {l}
                  </label>
                ))}
                {locations.length === 0 ? <small className="muted">No nodes yet.</small> : null}
              </div>
            </Line>
          </>
        ) : null}
        <Actions busy={busy} error={error} />
      </form>
      {v.mode === "custom" ? (
        <>
          <hr className="rule" />
          <h3 style={{ fontSize: "calc(14px * var(--text-scale))", marginBottom: 4 }}>Templates customers may use</h3>
          <p className="muted small" style={{ marginBottom: 8 }}>Nothing is released until you tick it. Customers see only these.</p>
          <State loading={templates.loading} error={templates.error}>
            <div className="chips">
              {items(templates.data).map((t) => (
                <label className="check" key={t.id}>
                  <input type="checkbox" checked={released[t.id] ?? !!t.customerVisible} onChange={(e) => void flip(t, e.target.checked)} />
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
                  {t.name}
                </label>
              ))}
            </div>
          </State>
        </>
      ) : null}
    </Card>
  );
}

// ---------- Limits ----------
function LimitsCard({ value, reload }: { value: Raw; reload: () => void }) {
  const { v, set, busy, error, save } = useSection("limits", value, reload);
  const templates = useLoad<Row[]>("/templates");
  const nodes = useLoad<Row[]>("/nodes");
  const locations = useMemo(() => [...new Set(items(nodes.data).map((n) => n.location as string))].sort(), [nodes.data]);
  return (
    <Card id="limits" title="Limits" description="What a customer may own. Defaults apply to everyone; plans add to them; a limit set on one customer wins." actions={<Status value={v.enabled ? (v.mode === "warn" ? "pending" : "active") : "stopped"} label={!v.enabled ? "Off" : v.mode === "warn" ? "Warn only" : "Enforced"} />}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save(v, "Limits saved"); }}>
        <Toggle label="Use limits" hint="Switch off to ignore every limit (nothing is deleted; your values are kept)." checked={v.enabled} onChange={(enabled) => set({ enabled })} />
        {v.enabled ? (
          <>
            <Sel label="When a limit would be exceeded" value={v.mode} onChange={(mode) => set({ mode })} options={[["enforce", "Stop it and say why"], ["warn", "Allow it, but tell the customer and the administrators"]]} hint="“Warn” is a good way to try limits out before they bite." />
            <Sel label="Administrators" value={v.adminOverride} onChange={(adminOverride) => set({ adminOverride })} options={[["force", "Are held to a customer’s limits unless they tick “force”"], ["always", "May always exceed a customer’s limits"]]} />
            <div className="form-grid">
              <Num label="Warn customers at (percent used)" value={v.warnPercent} min={1} max={100} onChange={(warnPercent) => set({ warnPercent })} />
            </div>
            <Toggle label="Let customers see their usage" checked={v.showUsage} onChange={(showUsage) => set({ showUsage })} />
            <Toggle label="Email and notify customers who reach a limit" checked={v.notifyCustomer} onChange={(notifyCustomer) => set({ notifyCustomer })} />
            <Toggle label="Allow per-customer overrides" hint="Limits set on a single customer’s page. Off hides them and ignores them." checked={v.allowOverrides} onChange={(allowOverrides) => set({ allowOverrides })} />
            <Toggle label="Count servers that come with a plan" hint="Normally a plan’s server is part of the plan and does not use the customer’s own allowance." checked={v.countPlanServers} onChange={(countPlanServers) => set({ countPlanServers })} />
            <hr className="rule" />
            <h3 style={{ fontSize: "calc(14px * var(--text-scale))" }}>Defaults for every customer</h3>
            <p className="muted small">Leave a field empty for no limit. Lowering a limit never deletes anything: existing servers keep running, only new ones are blocked.</p>
            <LimitSetEditor value={(v.defaults || {}) as LimitSet} onChange={(defaults) => set({ defaults })} templates={items(templates.data).map((t) => ({ id: t.id, name: t.name }))} locations={locations} />
          </>
        ) : null}
        <Actions busy={busy} error={error} />
      </form>
    </Card>
  );
}

// ---------- Billing ----------
function BillingCard({ value, reload }: { value: Raw; reload: () => void }) {
  const { v, set, busy, error, save } = useSection("billing", value, reload);
  const plugins = useLoad<{ plugins: Row[] }>("/plugins");
  const providers = (plugins.data?.plugins || []).filter((p) => p.payments);
  const [remind, setRemind] = useState((value.reminderDays || []).join(", "));
  const [cur, setCur] = useState((value.currencies || []).join(", "));
  useEffect(() => { setRemind((value.reminderDays || []).join(", ")); setCur((value.currencies || []).join(", ")); }, [value]);
  return (
    <Card id="billing" title="Billing" description="How payments, late payments, cancellations and customers' own choices work." actions={<Link href="/billing?tab=plans" className={btn("secondary", "sm")}>Plans and subscriptions</Link>}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ ...v, reminderDays: lines(remind).map(Number).filter(Number.isFinite), currencies: lines(cur).map((c) => c.toLowerCase()) }, "Billing settings saved");
        }}
      >
        <Line label="Payment provider" hint={providers.length ? "Install and set up a payment plugin under Plugins first (the Stripe plugin is included)." : "No payment plugin is installed yet. The Stripe plugin ships with the panel: install it under Plugins."}>
          <select className="input select" value={v.provider} onChange={(e) => set({ provider: e.target.value })}>
            <option value="">None</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.enabled ? "" : " (switched off)"}
              </option>
            ))}
          </select>
        </Line>
        <div className="form-grid">
          <Txt label="Default currency" value={v.currency} onChange={(currency) => set({ currency: currency.toLowerCase() })} mono placeholder="eur" hint="Three letters, for example eur, usd, gbp." />
          <Txt label="Currencies you accept" value={cur} onChange={setCur} mono placeholder="eur, usd, gbp" />
        </div>
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>When a payment fails</h3>
          <div className="form-grid">
            <Txt label="Reminder emails on day" value={remind} onChange={setRemind} mono placeholder="3, 14" hint="Days after the first failure. The first email goes out at once." />
            <Num label="Suspend the server after (days)" value={v.suspendAfterDays} min={0} max={365} onChange={(suspendAfterDays) => set({ suspendAfterDays })} hint="The server is stopped, not deleted, and starts again when the payment arrives." />
          </div>
          <Toggle label="Delete servers that stay unpaid or cancelled" hint="Off by default: nothing is ever deleted because of billing unless you turn this on. A last backup is taken first when backups are on." checked={v.autoTerminate} onChange={(autoTerminate) => set({ autoTerminate })} />
          {v.autoTerminate ? (
            <div className="form-grid">
              <Num label="Delete unpaid servers after (days)" value={v.terminateAfterDays} min={1} max={3650} onChange={(terminateAfterDays) => set({ terminateAfterDays })} />
              <Num label="Keep cancelled servers for (days)" value={v.retentionDays} min={0} max={3650} onChange={(retentionDays) => set({ retentionDays })} hint="Plans can override this." />
            </div>
          ) : (
            <Num label="Retention reminder after (days)" value={v.retentionDays} min={0} max={3650} onChange={(retentionDays) => set({ retentionDays })} hint="Cancelled servers wait for you; after this time you are reminded to remove them." />
          )}
          <Toggle label="Take a last backup before deleting" checked={v.finalBackup} onChange={(finalBackup) => set({ finalBackup })} />
          <Toggle label="A dispute stops the server" hint="While a customer disputes a payment with their bank." checked={v.suspendOnDispute} onChange={(suspendOnDispute) => set({ suspendOnDispute })} />
        </fieldset>
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>What customers may do</h3>
          <Toggle label="Cancel their subscription" checked={v.allowCustomerCancel} onChange={(allowCustomerCancel) => set({ allowCustomerCancel })} />
          <Toggle label="Resume a cancellation" checked={v.allowResume} onChange={(allowResume) => set({ allowResume })} />
          <Toggle label="Change plan" checked={v.allowPlanChange} onChange={(allowPlanChange) => set({ allowPlanChange })} />
          {v.allowPlanChange ? <Toggle label="Move to a smaller plan" checked={v.allowDowngrade} onChange={(allowDowngrade) => set({ allowDowngrade })} /> : null}
          <Sel label="Cancelling takes effect" value={v.cancelDefault} onChange={(cancelDefault) => set({ cancelDefault })} options={[["period_end", "At the end of the paid period"], ["immediate", "Customers may also end it immediately"]]} />
        </fieldset>
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>Emails and reminders</h3>
          <div className="form-grid">
            <Num label="Renewal reminder (days before)" value={v.renewalReminderDays} min={0} max={60} onChange={(renewalReminderDays) => set({ renewalReminderDays })} hint="0 turns it off." />
            <Num label="Trial ending notice (days before)" value={v.trialEndingDays} min={0} max={30} onChange={(trialEndingDays) => set({ trialEndingDays })} />
          </div>
          <Toggle label="Tell administrators about problems" hint="Failed payments, disputes and paid servers that could not be created." checked={v.notifyAdmins} onChange={(notifyAdmins) => set({ notifyAdmins })} />
          <Toggle label="Allow giving plans without payment" hint="Complimentary plans, for staff, partners or migrations." checked={v.allowManualGrants} onChange={(allowManualGrants) => set({ allowManualGrants })} />
        </fieldset>
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>Safety</h3>
          <div className="form-grid">
            <Num label="Checkouts per customer and hour" value={v.checkoutsPerHour} min={1} max={100} onChange={(checkoutsPerHour) => set({ checkoutsPerHour })} />
            <Num label="An unfinished checkout holds stock for (hours)" value={v.orderExpiryHours} min={1} max={168} onChange={(orderExpiryHours) => set({ orderExpiryHours })} />
            <Num label="Keep trying to create a paid server for (hours)" value={v.provisionRetryHours} min={1} max={168} onChange={(provisionRetryHours) => set({ provisionRetryHours })} />
            <Num label="Compare with the provider every (minutes)" value={v.reconcileMinutes} min={5} max={1440} onChange={(reconcileMinutes) => set({ reconcileMinutes })} hint="Repairs anything a missed notification left behind." />
          </div>
          <Sel label="If a paid server can never be created" value={v.failedFulfilment} onChange={(failedFulfilment) => set({ failedFulfilment })} options={[["manual", "Tell me and wait: I decide about the refund"], ["refund", "Refund and cancel automatically"]]} />
        </fieldset>
        <Actions busy={busy} error={error} />
      </form>
    </Card>
  );
}

// ---------- Store ----------
type Check = { id: string; label: string; ok: boolean; detail: string; blocking: boolean };
function StoreCard({ value, reload }: { value: Raw; reload: () => void }) {
  const { v, set, busy, error, save } = useSection("store", value, reload);
  const ready = useLoad<{ ready: boolean; checks: Check[] }>("/billing/readiness");
  const blocking = (ready.data?.checks || []).filter((c) => c.blocking && !c.ok);
  return (
    <Card id="store" title="Store" description="Sell plans to customers. Off by default." actions={<Status value={value.enabled ? "active" : "stopped"} label={value.enabled ? "Open" : "Closed"} />}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save(v, v.enabled ? "Store settings saved" : "Store closed"); }}>
        <Toggle label="Open the store" hint="Customers see the Store and Billing pages. It opens only when everything it needs works." checked={v.enabled} onChange={(enabled) => set({ enabled })} />
        {v.enabled && !value.enabled && blocking.length ? (
          <Notice tone="warn" title="Not ready yet">
            {blocking.map((b) => b.label).join("; ")}.
          </Notice>
        ) : null}
        <Toggle label="Show the catalogue to visitors who are not signed in" checked={v.publicCatalog} onChange={(publicCatalog) => set({ publicCatalog })} />
        <div className="form-grid">
          <Txt label="Store title" value={v.title} onChange={(title) => set({ title })} />
          <Sel label="Show prices first for" value={v.defaultInterval} onChange={(defaultInterval) => set({ defaultInterval })} options={[["month", "Monthly"], ["quarter", "Every 3 months"], ["semiannual", "Every 6 months"], ["year", "Yearly"]]} />
        </div>
        <Txt label="Introduction" rows={2} value={v.intro} onChange={(intro) => set({ intro })} placeholder="Game servers that just work." />
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>Who is selling</h3>
          <div className="form-grid">
            <Txt label="Company name" value={v.companyName} onChange={(companyName) => set({ companyName })} />
            <Txt label="Support email" value={v.companyEmail} onChange={(companyEmail) => set({ companyEmail })} placeholder="billing@example.com" />
            <Txt label="Tax or VAT number" value={v.companyTaxId} onChange={(companyTaxId) => set({ companyTaxId })} />
            <Txt label="Support page" value={v.supportUrl} onChange={(supportUrl) => set({ supportUrl })} placeholder="https://example.com/support" />
          </div>
          <Txt label="Postal address" rows={2} value={v.companyAddress} onChange={(companyAddress) => set({ companyAddress })} hint="Shown in the footer of receipts and billing emails." />
        </fieldset>
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>Terms</h3>
          <Toggle label="Customers accept the terms before paying" checked={v.requireTerms} onChange={(requireTerms) => set({ requireTerms })} />
          <div className="form-grid">
            <Txt label="Terms address" value={v.termsUrl} onChange={(termsUrl) => set({ termsUrl })} placeholder="https://example.com/terms" />
            <Txt label="Privacy address" value={v.privacyUrl} onChange={(privacyUrl) => set({ privacyUrl })} placeholder="https://example.com/privacy" />
          </div>
          <Txt label="Notice about the right of withdrawal" rows={3} value={v.withdrawalNotice} onChange={(withdrawalNotice) => set({ withdrawalNotice })} hint="For digital services, many countries need the customer to agree that the service starts at once. Ask a lawyer for the wording that fits your country." />
          <Txt label="Tax note under the prices" value={v.taxNote} onChange={(taxNote) => set({ taxNote })} placeholder="Prices include VAT." />
        </fieldset>
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>Tax, addresses and discounts</h3>
          <Toggle label="Calculate tax automatically" hint="Uses your payment provider’s tax feature (for Stripe: Stripe Tax). You must set it up there first." checked={v.automaticTax} onChange={(automaticTax) => set({ automaticTax })} />
          <Toggle label="Ask for a billing address" checked={v.collectAddress} onChange={(collectAddress) => set({ collectAddress })} />
          <Toggle label="Let business customers enter a tax number" checked={v.collectTaxId} onChange={(collectTaxId) => set({ collectTaxId })} />
          <Toggle label="Accept promotion codes" hint="Codes you create at your payment provider." checked={v.promoCodes} onChange={(promoCodes) => set({ promoCodes })} />
        </fieldset>
        <fieldset className="form-section" style={{ border: 0, padding: 0, margin: 0 }}>
          <h3>Display and limits</h3>
          <Toggle label="Show how much yearly saves" checked={v.showSavings} onChange={(showSavings) => set({ showSavings })} />
          <Sel label="Plans that are sold out" value={v.soldOut} onChange={(soldOut) => set({ soldOut })} options={[["show", "Show them as sold out"], ["hide", "Hide them"]]} />
          <Toggle label="Require a confirmed email address to buy" checked={v.requireVerifiedEmail} onChange={(requireVerifiedEmail) => set({ requireVerifiedEmail })} />
          <Num label="Active subscriptions per customer" value={v.maxActivePerCustomer} min={1} max={1000} onChange={(maxActivePerCustomer) => set({ maxActivePerCustomer })} />
        </fieldset>
        <Actions busy={busy} error={error} />
      </form>
    </Card>
  );
}

// ---------- Email templates ----------
type Template = { id: string; label: string; group: string; audience: string; critical: boolean; description: string; vars: { name: string; help: string; sample: string }[]; subject: string; body: string; html: string | null; enabled: boolean; customized: boolean; defaultSubject: string; defaultBody: string };

export function EmailTemplatesCard() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Template[]>("/email/templates");
  const [id, setId] = useState("welcome");
  const t = (data || []).find((x) => x.id === id) || (data || [])[0];
  const [draft, setDraft] = useState({ subject: "", body: "", html: "", enabled: true });
  const [preview, setPreview] = useState<{ subject: string; html: string; text: string; problems: string[] } | null>(null);
  const [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (t) {
      setDraft({ subject: t.subject, body: t.body, html: t.html || "", enabled: t.enabled });
      setPreview(null);
      setErr("");
    }
  }, [t?.id, t?.customized, data]);
  useEffect(() => {
    if (!t) return;
    const timer = setTimeout(() => {
      json("POST", `/email/templates/${t.id}/preview`, { subject: draft.subject, body: draft.body, html: draft.html || undefined })
        .then((p) => setPreview(p as typeof preview))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [t?.id, draft.subject, draft.body, draft.html]);
  const groups = useMemo(() => [...new Set((data || []).map((x) => x.group))], [data]);
  if (loading) return <Skeleton rows={4} />;
  if (error || !t) return <ErrorNotice message={error || "No templates"} />;
  const insert = (name: string) => {
    const el = area.current;
    const text = `{{${name}}}`;
    if (!el) return setDraft((d) => ({ ...d, body: d.body + text }));
    const a = el.selectionStart, b = el.selectionEnd;
    setDraft((d) => ({ ...d, body: d.body.slice(0, a) + text + d.body.slice(b) }));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + text.length, a + text.length); });
  };
  async function save() {
    setBusy(true);
    setErr("");
    try {
      await json("PUT", `/email/templates/${t.id}`, { subject: draft.subject, body: draft.body, html: draft.html || undefined, enabled: draft.enabled });
      toast({ tone: "ok", title: "Template saved", description: t.label });
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const dirty = draft.subject !== t.subject || draft.body !== t.body || (draft.html || "") !== (t.html || "") || draft.enabled !== t.enabled;
  return (
    <Card id="email-templates" title="Email templates" description="The words of every email the panel sends. Edit the text; the layout follows your Appearance settings.">
      <div className="mail">
        <div className="mail__list" role="list">
          {groups.map((g) => (
            <div key={g}>
              <div className="mail__group">{g}</div>
              {(data || []).filter((x) => x.group === g).map((x) => (
                <button key={x.id} type="button" className="mail__item" aria-current={x.id === t.id} onClick={() => setId(x.id)}>
                  <span>{x.label}</span>
                  {x.customized ? <span className="tag tag--accent">Edited</span> : !x.enabled ? <span className="tag">Off</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="stack mail__edit">
          <div>
            <strong>{t.label}</strong>
            <p className="muted small">{t.description}</p>
          </div>
          {!t.critical ? <Toggle label="Send this email" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} /> : <Notice tone="neutral">Security and billing-critical emails always go out.</Notice>}
          <Line label="Subject">
            <input className="input" value={draft.subject} maxLength={200} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </Line>
          <Line label="Message" hint={<>Blank line starts a new paragraph. <code>- item</code> makes a list, <code>**bold**</code> bold, <code>{"[button: Label | {{link}}]"}</code> a button, <code>{"{{#if name}}…{{/if}}"}</code> shows text only when a value exists.</>}>
            <textarea ref={area} className="input" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} spellCheck />
          </Line>
          <div className="vars" aria-label="Variables you can insert">
            {t.vars.map((v) => (
              <button type="button" key={v.name} title={`${v.help} (for example: ${v.sample})`} onClick={() => insert(v.name)}>
                {`{{${v.name}}}`}
              </button>
            ))}
          </div>
          <details>
            <summary className="text-button">Advanced: write the HTML yourself</summary>
            <Line label="Custom HTML (replaces the generated layout)" hint="Variables are escaped for you. Leave empty to use the generated layout.">
              <textarea className="input mono" rows={8} value={draft.html} onChange={(e) => setDraft({ ...draft, html: e.target.value })} />
            </Line>
          </details>
          {preview?.problems.length ? <Notice tone="warn" title="Fix before saving">{preview.problems.join(". ")}.</Notice> : null}
          <ErrorNotice message={err} />
          <div className="form__actions">
            <Button variant="primary" busy={busy} disabled={!dirty || !!preview?.problems.length} onClick={save}>Save</Button>
            <Button onClick={async () => { try { await json("POST", `/email/templates/${t.id}/test`); toast({ tone: "ok", title: "Test email sent to you" }); } catch (e) { toast({ tone: "bad", title: "Could not send", description: (e as Error).message }); } }}>Send me a test</Button>
            {t.customized ? <Button variant="ghost" onClick={async () => { await json("DELETE", `/email/templates/${t.id}`); reload(); }}>Reset to the original</Button> : null}
          </div>
          {preview ? (
            <>
              <p className="muted small">Subject: <strong>{preview.subject}</strong> · shown with sample values</p>
              <iframe className="mail__preview" title="Email preview" sandbox="" srcDoc={preview.html} />
            </>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function DeliveryLogCard() {
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useLoad<{ items: Row[]; counts: Record<string, number> }>(`/email/outbox?limit=50${status ? `&status=${status}` : ""}`, 15000);
  const c = data?.counts || {};
  return (
    <Card
      id="email-log"
      flush
      title="Delivery log"
      description={`Sent ${c.sent || 0} · waiting ${c.queued || 0} · failed ${c.failed || 0}. Messages that fail are retried with growing pauses.`}
      actions={
        <select className="input select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
          <option value="">All</option>
          <option value="queued">Waiting</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
      }
    >
      <State loading={loading} error={error}>
        <DataTable
          data={items(data?.items)}
          rowKey={(m) => String(m.id)}
          empty="No emails yet."
          columns={[
            { id: "to", header: "To", value: (m) => m.to, render: (m) => <span>{m.to}</span> },
            { id: "subject", header: "Subject", optional: true, value: (m) => m.subject, render: (m) => <span className="muted">{m.subject}</span> },
            { id: "t", header: "Template", optional: true, value: (m) => m.template, render: (m) => <span className="mono">{m.template}</span> },
            { id: "s", header: "Status", value: (m) => m.status, render: (m) => <Status tone={m.status === "sent" ? "ok" : m.status === "failed" ? "bad" : "busy"} label={m.status === "sent" ? "Sent" : m.status === "failed" ? "Failed" : "Waiting"} /> },
            { id: "w", header: "When", value: (m) => m.createdAt, render: (m) => <time className="muted" title={fmtTime(m.createdAt)}>{fmtAgo(m.createdAt)}</time> },
            { id: "e", header: "Detail", optional: true, value: (m) => m.lastError || "", render: (m) => <span className="muted">{m.lastError || (m.attempts > 1 ? `${m.attempts} attempts` : "")}</span> },
            { id: "x", header: "", sortable: false, align: "end", value: () => "", render: (m) => (m.status !== "sent" ? <Button size="sm" onClick={async () => { await json("POST", `/email/outbox/${m.id}/retry`); reload(); }}>Try again</Button> : null) },
          ]}
        />
      </State>
    </Card>
  );
}

/** Everything added in 0.7.1.1 that an administrator can configure. */
export default function RookerySettings() {
  const { data, error, loading, reload } = useLoad<All>("/settings");
  if (loading) return <Skeleton rows={3} />;
  if (error || !data) return <ErrorNotice message={error || "Settings could not be loaded."} />;
  return (
    <div className="stack">
      <SignupCard value={data.signup} reload={reload} email={!!data.email?.enabled} />
      <SelfServiceCard value={data.selfService} reload={reload} />
      <LimitsCard value={data.limits} reload={reload} />
      <BillingCard value={data.billing} reload={reload} />
      <StoreCard value={data.store} reload={reload} />
      <EmailTemplatesCard />
      <DeliveryLogCard />
    </div>
  );
}
void CircleAlert;void CircleCheck;void CircleDashed;
