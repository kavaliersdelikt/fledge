"use client";
import { items, json, type Quota, type QuotaUsage } from "@/lib/api";
import { statusLabel, type LimitsView } from "@/lib/commerce";
import { LimitSetEditor, LimitUsage, type LimitSet } from "./LimitsUI";
import { fmtCpu, fmtDay, fmtMb, fmtTime } from "@/lib/format";
import { formToQuota, hasQuota, quotaShare, quotaToForm, type QuotaForm } from "@/lib/quota";
import { CircleDashed, Gauge, KeyRound, LogOut, MoreHorizontal, Plus, Send, UserCheck, UserX } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import DataTable, { type DataColumn } from "./DataTable";
import { Drawer, Modal, Secret, useConfirm } from "./feedback";
import { useToast } from "./toast";
import {
  Button,
  Card,
  Empty,
  ErrorNotice,
  Field,
  Form,
  Meter,
  Notice,
  PageHeader,
  Pager,
  Row,
  SearchInput,
  State,
  Switch,
  Toolbar,
  btn,
  useLoad,
} from "./shared";

/** A throwaway password nobody ever sees: the invitation link is how the customer gets in. */
function randomPassword(length = 28): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!#%+=";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // Rejection sampling avoids modulo bias.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  for (const b of bytes) if (b < limit) out += alphabet[b % alphabet.length];
  return out.length >= 24 ? out : randomPassword(length + 8);
}

type Line = { key: string; label: string; used: number; limit?: number | null; fmt: (n: number) => string };

function usageLines(quota: Quota | undefined, usage: Partial<QuotaUsage> | undefined): Line[] {
  const u = usage || {};
  const q = quota || {};
  const n = (v: number) => String(v);
  const lines: Line[] = [
    { key: "servers", label: "Servers", used: u.servers ?? 0, limit: q.maxServers, fmt: n },
    { key: "memory", label: "Memory", used: u.memoryMb ?? 0, limit: q.maxMemoryMb, fmt: fmtMb },
    { key: "cpu", label: "CPU", used: u.cpuPercent ?? 0, limit: q.maxCpuPercent, fmt: fmtCpu },
    { key: "disk", label: "Disk", used: u.diskMb ?? 0, limit: q.maxDiskMb, fmt: fmtMb },
  ];
  if (u.backups !== undefined || q.maxBackups != null) lines.push({ key: "backups", label: "Backups", used: u.backups ?? 0, limit: q.maxBackups, fmt: n });
  if (u.extraPorts !== undefined || q.maxExtraPorts != null) lines.push({ key: "ports", label: "Extra ports", used: u.extraPorts ?? 0, limit: q.maxExtraPorts, fmt: n });
  return lines;
}

function UsageBar({ line, compact = false }: { line: Line; compact?: boolean }) {
  const limited = line.limit !== undefined && line.limit !== null;
  const share = quotaShare(line.used, line.limit);
  return (
    <div className={`usage${compact ? "" : " usage--wide"}`}>
      <span className="usage__text">
        <span>{limited ? `${line.fmt(line.used)} / ${line.fmt(line.limit as number)}` : line.fmt(line.used)}</span>
        {!limited && !compact ? <small>no limit</small> : null}
      </span>
      {limited ? (
        <Meter
          label={`${line.label} in use`}
          value={Math.min(line.used, (line.limit as number) || line.used || 1)}
          max={(line.limit as number) || 1}
        />
      ) : null}
      {share !== null && share >= 100 && !compact ? <small className="quota-row__full">Limit reached</small> : null}
    </div>
  );
}

function LimitField({
  label,
  unit,
  value,
  onChange,
  step,
  hint,
}: {
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  step?: string;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <span className={unit ? "input-unit" : undefined}>
        <input
          className="input"
          type="number"
          inputMode="decimal"
          min={0}
          step={step || "1"}
          value={value}
          placeholder="No limit"
          onChange={(e) => onChange(e.target.value)}
        />
        {unit ? <span aria-hidden="true">{unit}</span> : null}
      </span>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

function QuotaEditor({ customer, onClose, onSaved }: { customer: Row; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const view = useLoad<LimitsView & { override: LimitSet; defaults: LimitSet }>(`/customers/${customer.id}/limits`);
  const templates = useLoad<Row[]>("/templates");
  const nodes = useLoad<Row[]>("/nodes");
  const locations = [...new Set(items(nodes.data).map((n) => n.location as string))].sort();
  const [draft, setDraft] = useState<LimitSet | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (view.data && draft === null) setDraft({ ...view.data.override });
  }, [view.data]);
  async function save(clear = false) {
    setError("");
    setBusy(true);
    try {
      await json("PATCH", `/customers/${customer.id}`, { quota: clear ? {} : draft });
      toast({ tone: "ok", title: clear ? "Limits set by hand removed" : "Limits saved", description: customer.email });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title="Limits"
      description={`What ${customer.email} can own. Anything you fill in here beats the panel defaults and their plans. Existing servers keep running if they are already over a new limit.`}
    >
      <State loading={view.loading || draft === null} error={view.error}>
        {view.data && draft ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Card title="What applies now" description="Panel defaults, plus any plan, then whatever you set below.">
              <LimitUsage view={view.data} adminView />
            </Card>
            <h3 style={{ fontSize: "calc(14px * var(--text-scale))" }}>Set by hand for this customer</h3>
            <LimitSetEditor value={draft} onChange={setDraft} inherit="Use the default" templates={items(templates.data).map((t) => ({ id: t.id, name: t.name }))} locations={locations} />
            <ErrorNotice message={error} />
            <div className="modal__actions">
              <Button onClick={() => void save(true)} disabled={busy || Object.keys(view.data.override).length === 0}>Remove everything set by hand</Button>
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" busy={busy}>Save limits</Button>
            </div>
          </form>
        ) : null}
      </State>
    </Modal>
  );
}

/** Accounts that signed themselves up and are not finished yet. */
function PendingCard({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, reload } = useLoad<Row[]>("/signup/pending", 20000);
  if (!data?.length) return null;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast({ tone: "ok", title: done });
      reload();
      onChanged();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  };
  return (
    <Card title="Waiting for you" description="People who signed up and are not finished." className="pending-card">
      <ul className="checks">
        {data.map((p) => (
          <li key={p.id} className="soft">
            <CircleDashed aria-hidden="true" />
            <span className="row-between">
              <span>
                {p.email}
                <small>
                  {p.status === "pending_approval" ? "Confirmed their address; waiting for your approval" : "Has not confirmed their email address yet"} · {fmtDay(p.createdAt)}
                </small>
              </span>
              <span className="btn-group">
                {p.status === "pending_approval" ? (
                  <Button size="sm" variant="primary" onClick={() => run(() => json("POST", `/customers/${p.id}/approve`), "Approved")}>
                    Approve
                  </Button>
                ) : (
                  <>
                    <Button size="sm" onClick={() => run(() => json("POST", `/customers/${p.id}/resend-verification`), "Link sent again")}>
                      Resend link
                    </Button>
                    <Button size="sm" onClick={() => run(() => json("POST", `/customers/${p.id}/mark-verified`), "Marked as confirmed")}>
                      Mark confirmed
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (await confirm(`${p.email} is told no and the account is removed.`, { confirmLabel: "Decline" })) void run(() => json("POST", `/customers/${p.id}/reject`), "Declined");
                  }}
                >
                  Decline
                </Button>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A customer's plans, and a way to give them one. */
function PlansOfCustomer({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoad<{ items: Row[] }>(`/billing/admin/subscriptions?user=${id}&limit=50`);
  const toast = useToast();
  const plans = useLoad<Row[]>("/plans");
  const [pick, setPick] = useState("");
  async function give() {
    try {
      await json("POST", "/billing/grants", { userId: id, planId: pick });
      toast({ tone: "ok", title: "Plan given" });
      setPick("");
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  }
  return (
    <div className="cust-detail">
      <div className="cust-detail__head">
        <h3>Plans</h3>
        <Link href={`/billing?tab=subscriptions`} className="text-button">Open in Billing</Link>
      </div>
      <State loading={loading} error={error} rows={2}>
        {items(data?.items).length ? (
          <ul className="limit-list">
            {items(data?.items).map((s) => (
              <li className="limit-row" key={s.id}>
                <div className="limit-row__text">
                  <span>{s.planName}</span>
                  <strong>{statusLabel[s.status] || s.status}</strong>
                </div>
                <small>{s.provider === "manual" ? "Complimentary" : `${s.amountText} · ${s.cycle}`}{s.currentPeriodEnd ? ` · ${s.cancelAtPeriodEnd ? "ends" : "renews"} ${fmtDay(s.currentPeriodEnd)}` : ""}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No plans yet.</p>
        )}
      </State>
      {items(plans.data).length ? (
        <div className="row-between" style={{ marginTop: 10 }}>
          <select className="input select" aria-label="Plan to give" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1 }}>
            <option value="">Give a plan…</option>
            {items(plans.data).filter((p) => !p.archivedAt).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <Button disabled={!pick} onClick={give}>Give</Button>
        </div>
      ) : null}
    </div>
  );
}

export default function Customers() {
  const confirm = useConfirm();
  const [offset, setOffset] = useState(0),
    [creating, setCreating] = useState(false),
    [password, setPassword] = useState<{ email: string; value: string } | null>(null),
    [link, setLink] = useState<{ email: string; value: string } | null>(null),
    [editing, setEditing] = useState<Row | null>(null),
    [viewing, setViewing] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    toast = useToast();
  const { data, error, loading, reload } = useLoad<Row[]>(`/customers?limit=50&offset=${offset}`);
  const all = items(data);
  const list = all.filter((c) => c.email.toLowerCase().includes(query.toLowerCase()));
  const viewed = all.find((c) => c.id === viewing) || null;
  const detail = useLoad<Row>(viewing ? `/customers/${viewing}` : null);

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) toast({ tone: "ok", title: done });
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  }

  async function invite(c: Row) {
    await act(async () => {
      const r = (await json("POST", `/customers/${c.id}/invite`)) as { sent?: boolean; link?: string };
      if (r?.sent) toast({ tone: "ok", title: "Invitation sent", description: c.email });
      else if (r?.link) setLink({ email: c.email, value: r.link });
      else toast({ tone: "ok", title: "Invitation created" });
    });
  }
  async function signOutEverywhere(c: Row) {
    if (!(await confirm(`${c.email} is signed out of every browser and has to sign in again.`, { confirmLabel: "Sign out everywhere" }))) return;
    void act(async () => {
      const r = (await json("POST", `/customers/${c.id}/sign-out`)) as { revoked?: number };
      toast({ tone: "ok", title: r?.revoked ? `Signed out ${r.revoked} ${r.revoked === 1 ? "session" : "sessions"}` : "No active sessions", description: c.email });
    });
  }
  async function resetPassword(c: Row) {
    if (
      await confirm(`${c.email} gets a new password and is signed out everywhere. You’ll see the password once.`, {
        confirmLabel: "Reset password",
      })
    )
      void act(async () => {
        const next = randomPassword(32);
        await json("PATCH", `/customers/${c.id}`, { password: next });
        setPassword({ email: c.email, value: next });
      });
  }
  async function toggleDisabled(c: Row) {
    if (
      await confirm(
        c.disabled ? `${c.email} can sign in again.` : `${c.email} can’t sign in until you enable the account again.`,
        { danger: !c.disabled, confirmLabel: c.disabled ? "Enable" : "Suspend" },
      )
    )
      void act(
        () => json("PATCH", `/customers/${c.id}`, { disabled: !c.disabled }),
        c.disabled ? `${c.email} enabled` : `${c.email} suspended`,
      );
  }

  const menu = (c: Row) => (
    <>
      <DropdownMenuItem onClick={() => setEditing(c)}>
        <Gauge /> Edit limits
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void invite(c)}>
        <Send /> Send invitation
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void resetPassword(c)}>
        <KeyRound /> Reset password
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void signOutEverywhere(c)}>
        <LogOut /> Sign out everywhere
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className={c.disabled ? undefined : "is-danger"} onClick={() => void toggleDisabled(c)}>
        {c.disabled ? <UserCheck /> : <UserX />} {c.disabled ? "Enable account" : "Suspend account"}
      </DropdownMenuItem>
    </>
  );

  const columns: DataColumn<Row>[] = [
    {
      id: "email",
      header: "Email",
      value: (c) => c.email,
      render: (c) => (
        <span className="ident">
          <button type="button" className="text-button cust-name" onClick={() => setViewing(c.id)} aria-label={`Details for ${c.email}`}>
            {c.email}
          </button>
          {c.disabled ? <span className="tag">Suspended</span> : null}
          {c.status === "deletion_pending" ? <span className="tag">Deleting</span> : null}
          {c.signupSource && c.signupSource !== "admin" ? <span className="tag" title="Signed up by themselves">{c.signupSource === "invite" ? "Invited" : "Signed up"}</span> : null}
        </span>
      ),
    },
    {
      id: "servers",
      header: "Servers",
      align: "end",
      value: (c) => c.serverCount ?? 0,
      render: (c) => {
        const line = usageLines(c.quota, { servers: c.usage?.servers ?? c.serverCount ?? 0 })[0];
        return <UsageBar line={line} compact />;
      },
    },
    {
      id: "memory",
      header: "Memory",
      optional: true,
      value: (c) => c.usage?.memoryMb ?? 0,
      render: (c) => <UsageBar line={usageLines(c.quota, c.usage)[1]} compact />,
    },
    {
      id: "created",
      header: "Joined",
      optional: true,
      value: (c) => c.createdAt || "",
      render: (c) => (
        <time className="muted" title={fmtTime(c.createdAt)}>
          {fmtDay(c.createdAt)}
        </time>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (c) => (
        <DropdownMenu>
          <DropdownMenuTrigger className={btn("ghost", "icon", "btn--sm")} aria-label={`Actions for ${c.email}`}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="menu">
            {menu(c)}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        nav="customers"
        title="Customers"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New customer
          </Button>
        }
      />
      {all.length > 8 && (
        <Toolbar>
          <span />
          <SearchInput label="Search customers" placeholder="Search by email" value={query} onChange={setQuery} />
        </Toolbar>
      )}
      <PendingCard onChanged={reload} />
      <Card flush>
        <State loading={loading} error={error} rows={5}>
          {list.length ? (
            <DataTable data={list} rowKey={(c) => c.id} columns={columns} />
          ) : all.length ? (
            <Empty title="No matching customers" />
          ) : (
            <Empty
              title="No customers yet"
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  Create a customer
                </Button>
              }
            >
              Every server belongs to a customer account.
            </Empty>
          )}
          <Pager offset={offset} setOffset={setOffset} count={all.length} />
        </State>
      </Card>

      <CreateCustomer
        open={creating}
        onOpenChange={setCreating}
        onCreated={(r) => {
          if (r.password) setPassword({ email: r.email, value: r.password });
          if (r.link) setLink({ email: r.email, value: r.link });
          reload();
        }}
      />

      <Drawer
        open={!!viewing}
        onOpenChange={(o) => !o && setViewing(null)}
        title={viewed?.email || detail.data?.email || "Customer"}
        description={viewed ? `Joined ${fmtDay(viewed.createdAt)}${viewed.disabled ? " · Suspended" : ""}` : undefined}
      >
        {viewed && (
          <div className="stack">
            <div className="cust-detail">
              <div className="cust-detail__head">
                <h3>Usage</h3>
                {hasQuota(viewed.quota) ? <span className="tag tag--accent">Limits set</span> : <span className="tag">No limits</span>}
              </div>
              <State loading={detail.loading && !viewed.usage} error={detail.error} rows={3}>
                <ul className="quota-list">
                  {usageLines((detail.data || viewed).quota, { ...viewed.usage, ...(detail.data?.usage || {}) }).map((line) => (
                    <li className="quota-row" key={line.key}>
                      <div className="quota-row__text">
                        <span>{line.label}</span>
                      </div>
                      <UsageBar line={line} />
                    </li>
                  ))}
                </ul>
              </State>
            </div>
            <PlansOfCustomer id={viewed.id} />
            <div className="btn-group">
              <Button onClick={() => setEditing(viewed)}>
                <Gauge /> Edit limits
              </Button>
              <Button onClick={() => void invite(viewed)}>
                <Send /> Send invitation
              </Button>
              <Button onClick={() => void signOutEverywhere(viewed)}>
                <LogOut /> Sign out everywhere
              </Button>
            </div>
            <div className="toggle-row">
              <div>
                <strong>{viewed.disabled ? "Account suspended" : "Account active"}</strong>
                <small>{viewed.disabled ? "They can’t sign in." : "Suspend to block sign-in without deleting anything."}</small>
              </div>
              <Switch label="Account enabled" checked={!viewed.disabled} onChange={() => void toggleDisabled(viewed)} />
            </div>
            <p className="faint small">
              <Link href="/servers" className="text-button">
                Open all servers
              </Link>{" "}
              to see what this customer runs.
            </p>
          </div>
        )}
      </Drawer>

      {editing && (
        <QuotaEditor
          key={editing.id}
          customer={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
            if (viewing) detail.reload();
          }}
        />
      )}

      <Modal
        open={!!password}
        onOpenChange={(o) => !o && setPassword(null)}
        title="Password for this account"
        description={password ? `Share it with ${password.email} securely. It isn’t shown again.` : undefined}
      >
        {password && <Secret label="Password" value={password.value} />}
      </Modal>
      <Modal
        open={!!link}
        onOpenChange={(o) => !o && setLink(null)}
        title="Invitation link"
        description={link ? `Email isn’t set up, so nothing was sent. Share this link with ${link.email} yourself. It works once and expires.` : undefined}
      >
        {link && <Secret label="Link" value={link.value} />}
      </Modal>
    </>
  );
}

type Created = { email: string; password?: string; link?: string };

function CreateCustomer({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (r: Created) => void;
}) {
  const toast = useToast();
  // Only fetched while the drawer is open; tells us whether invitation emails can go out.
  const settings = useLoad<{ email?: { enabled: boolean } }>(open ? "/settings" : null);
  const emailOn = !!settings.data?.email?.enabled;
  const [invite, setInvite] = useState(false);
  const asInvite = emailOn && invite;
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setInvite(false);
      }}
      title="New customer"
      description={
        asInvite
          ? "They get an email with a link to choose their own password."
          : "Leave the password empty to generate one. Nothing is emailed — you share the details yourself."
      }
    >
      <Form
        submit={asInvite ? "Create and send invitation" : "Create customer"}
        success={false}
        onSubmit={async (v) => {
          const email = String(v.email).trim();
          if (asInvite) {
            const created = (await json("POST", "/customers", { email, password: randomPassword() })) as Row;
            onOpenChange(false);
            setInvite(false);
            try {
              const r = (await json("POST", `/customers/${created.id}/invite`)) as { sent?: boolean; link?: string };
              if (r?.sent) toast({ tone: "ok", title: "Invitation sent", description: email });
              onCreated({ email, link: r?.sent ? undefined : r?.link });
            } catch (e) {
              toast({ tone: "bad", title: "Customer created, but the invitation failed", description: `${(e as Error).message} Use “Send invitation” on their row to try again.` });
              onCreated({ email });
            }
            return;
          }
          const r = (await json("POST", "/customers", { email, password: v.password || undefined })) as Row;
          onOpenChange(false);
          onCreated({ email: r.email, password: r.temporaryPassword });
        }}
      >
        <Field label="Email" name="email" type="email" required autoComplete="off" />
        {emailOn && (
          <label className="check-line">
            <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
            Send an invitation email instead of setting a password
          </label>
        )}
        {settings.error && open ? <Notice tone="warn">Couldn’t check whether email is set up: {settings.error}</Notice> : null}
        {!asInvite && <Field label="Password" name="password" type="password" autoComplete="new-password" hint="Optional. At least 12 characters." />}
      </Form>
      <p className="faint small">
        After creating the account, assign it a server from{" "}
        <Link href="/servers?new=1" className="text-button">
          New server
        </Link>
        .
      </p>
    </Drawer>
  );
}
