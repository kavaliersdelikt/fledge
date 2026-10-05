"use client";
import { useEffect, useRef, useState } from "react";
import { API, json, type User, type Server } from "@/lib/api";
import { useBrand, BrandMark } from "@/lib/brand";
import { fmtDay } from "@/lib/format";
import { useFeatures } from "@/lib/commerce";
import {
  LockKeyhole,
  Receipt,
  ShieldCheck,
  Clock,
  MessageCircle,
  Download,
  LogOut,
  FileWarning,
  Search,
  HeartHandshake,
  HelpCircle,
} from "lucide-react";
import { Button, Card, Form, Field, Notice, State, useLoad } from "./shared";
import { CopyButton } from "./feedback";
import { AccountOptionsCard } from "./AccountCards";
import { PasskeysCard, SessionsCard } from "./AccountSecurity";
import Billing from "./Billing";
import { TicketThread } from "./Support";
export type Suspension = {
  id: string;
  reference: string;
  reason: string;
  message: string;
  displayName: string;
  createdAt: string;
  liftedAt: string | null;
  until: string | null;
  stopServers: boolean;
  allowBackupDownload: boolean;
  allowAccountDeletion: boolean;
  liftOnPayment: boolean;
  retentionDays: number;
  appealsEnabled: boolean;
  ticketId: string | null;
};
export const reasons = [
  {
    value: "billing",
    label: "Payment overdue",
    icon: Receipt,
    tone: "warn",
    message:
      "An outstanding invoice needs your attention. Please settle it to restore your account.",
  },
  {
    value: "terms",
    label: "Terms of service",
    icon: FileWarning,
    tone: "bad",
    message:
      "We need to discuss a terms of service issue. Please contact us so we can resolve it.",
  },
  {
    value: "security",
    label: "Security concern",
    icon: ShieldCheck,
    tone: "busy",
    message:
      "We paused access to protect your account. Please secure your sign-in details and contact us.",
  },
  {
    value: "review",
    label: "Under review",
    icon: Search,
    tone: "neutral",
    message:
      "Your account is under review. We will update you here as soon as we have more information.",
  },
  {
    value: "requested",
    label: "At your request",
    icon: HeartHandshake,
    tone: "ok",
    message:
      "Your account is paused as requested. Contact us when you are ready to resume.",
  },
  {
    value: "other",
    label: "Other",
    icon: HelpCircle,
    tone: "neutral",
    message:
      "Your account has been paused. Please contact us to discuss the next steps.",
  },
];
export function SuspensionPreview({
  reason,
  message,
  host,
}: {
  reason: string;
  message: string;
  host: string;
}) {
  const r = reasons.find((x) => x.value === reason) || reasons[3],
    Icon = r.icon;
  return (
    <div className="mews-preview" data-tone={r.tone}>
      <Icon size={30} />
      <span className="tag">{r.label}</span>
      <h2>Your account is paused</h2>
      <p>{host} has paused access to your servers.</p>
      <blockquote>{message}</blockquote>
      <small>Billing, your data and account security remain available.</small>
    </div>
  );
}
export default function SuspendedShell({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => Promise<void>;
}) {
  const { brand } = useBrand(),
    features = useFeatures();
  const {
      data: s,
      error,
      loading,
      reload,
    } = useLoad<Suspension>("/suspension", 30000),
    servers = useLoad<Server[]>("/servers");
  const [view, setView] = useState("overview"),
    [body, setBody] = useState(""),
    [sending, setSending] = useState(false),
    [problem, setProblem] = useState(""),
    [now, setNow] = useState(Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [view]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  const reason = reasons.find((r) => r.value === s?.reason) || reasons[3],
    Icon = reason.icon;
  async function appeal() {
    setSending(true);
    setProblem("");
    try {
      await json("POST", "/suspension/appeal", { body });
      setBody("");
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="mews-shell" data-tone={reason.tone}>
      <header className="mews-top">
        <div className="brand">
          <BrandMark />
        </div>
        <span>{user.email}</span>
        <Button variant="ghost" onClick={onLogout}>
          <LogOut size={16} /> Sign out
        </Button>
      </header>
      <main className="mews-main">
        <nav className="mews-nav" aria-label="Account">
          <Button
            variant={view === "overview" ? "primary" : "ghost"}
            onClick={() => setView("overview")}
          >
            Overview
          </Button>
          <Button
            variant={view === "billing" ? "primary" : "ghost"}
            onClick={() => setView("billing")}
          >
            Billing
          </Button>
          <Button
            variant={view === "data" ? "primary" : "ghost"}
            onClick={() => setView("data")}
          >
            Your data
          </Button>
          <Button
            variant={view === "security" ? "primary" : "ghost"}
            onClick={() => setView("security")}
          >
            Security
          </Button>
        </nav>
        <State loading={loading} error={error}>
          {null}
        </State>
        {s && (
          <>
            {view === "overview" ? (
              <>
                <section className="mews-hero">
                  <div className="mews-emblem">
                    <BrandMark name={false} />
                    <Icon size={25} />
                  </div>
                  <span className="tag">{reason.label}</span>
                  <h1 tabIndex={-1} ref={heading}>
                    Your account is paused
                  </h1>
                  <p>
                    {brand.identity.name} has paused your account.{" "}
                    {s.stopServers
                      ? "Your servers are stopped."
                      : "Your servers may still be running."}{" "}
                    Your data has not been deleted.
                  </p>
                  <div className="mews-facts">
                    <span>Since {fmtDay(s.createdAt)}</span>
                    <span>
                      {s.reference}
                      <CopyButton value={s.reference} label="Copy reference" />
                    </span>
                    {s.until && (
                      <span>
                        <Clock size={15} />
                        {Math.max(
                          0,
                          Math.ceil(
                            (new Date(s.until).getTime() - now) / 3600000,
                          ),
                        )}{" "}
                        h until scheduled lift
                      </span>
                    )}
                  </div>
                </section>
                <div className="mews-grid">
                  <div className="mews-primary">
                    <Card title="A message from your host">
                      <blockquote className="mews-quote">
                        {s.message}
                      </blockquote>
                      <p className="muted">
                        {s.displayName} · {fmtDay(s.createdAt)}
                      </p>
                      {s.reason === "billing" && (
                        <Button
                          variant="primary"
                          onClick={() => setView("billing")}
                        >
                          View invoices
                        </Button>
                      )}
                      {s.reason === "security" && (
                        <Button
                          variant="primary"
                          onClick={() => setView("security")}
                        >
                          Secure your account
                        </Button>
                      )}
                    </Card>
                    <section className="mews-allowed">
                      <h2>You can still</h2>
                      <div className="mews-actions">
                        <button onClick={() => setView("data")}>
                          <Download />
                          <span>Download your data</span>
                        </button>
                        <button onClick={() => setView("billing")}>
                          <Receipt />
                          <span>Billing and invoices</span>
                        </button>
                        <button onClick={() => setView("security")}>
                          <ShieldCheck />
                          <span>Account security</span>
                        </button>
                        {s.allowAccountDeletion &&
                          features.account.allowDeletion && (
                            <button onClick={() => setView("data")}>
                              <LockKeyhole />
                              <span>Delete your account</span>
                            </button>
                          )}
                      </div>
                    </section>
                    <Card title="What happens next">
                      <ol className="mews-timeline">
                        <li>
                          <strong>Account paused</strong>
                          <span>{fmtDay(s.createdAt)}</span>
                        </li>
                        <li>
                          <strong>Resolve the issue</strong>
                          <span>
                            {s.reason === "billing"
                              ? "Review your invoices, then pay any outstanding balance."
                              : "Read the host’s message and reply below."}
                          </span>
                        </li>
                        <li>
                          <strong>Access restored</strong>
                          <span>
                            {s.until
                              ? `Scheduled for ${fmtDay(s.until)}.`
                              : s.liftOnPayment
                                ? "Automatically after outstanding payments are settled."
                                : "Your host will review the account and lift the pause."}
                          </span>
                        </li>
                        {s.retentionDays > 0 && (
                          <li>
                            <strong>If nothing changes</strong>
                            <span>
                              Contact your host before{" "}
                              {fmtDay(
                                new Date(
                                  new Date(s.createdAt).getTime() +
                                    s.retentionDays * 86400000,
                                ).toISOString(),
                              )}{" "}
                              to discuss retention.
                            </span>
                          </li>
                        )}
                      </ol>
                    </Card>
                  </div>
                  <aside className="mews-aside">
                    <Card
                      title={s.stopServers ? "Paused servers" : "Your servers"}
                    >
                      {servers.data?.map((server) => (
                        <div className="mews-server" key={server.id}>
                          <LockKeyhole size={17} />
                          <span>
                            <strong>{server.name}</strong>
                            <small>
                              {server.status} ·{" "}
                              {server.suspended
                                ? "On hold"
                                : "Access restricted"}
                            </small>
                          </span>
                        </div>
                      ))}
                      <p className="muted">
                        Your data is kept on the host’s servers.
                      </p>
                    </Card>
                    {s.allowBackupDownload && servers.data && (
                      <SuspensionBackups servers={servers.data} />
                    )}
                    <Card title="Talk to your host">
                      {s.ticketId ? (
                        <TicketThread id={s.ticketId} compact />
                      ) : s.appealsEnabled ? (
                        <>
                          <p>
                            Tell your host what changed or ask for help. Your
                            message opens an appeal ticket.
                          </p>
                          <label className="field">
                            <span>Your message</span>
                            <textarea
                              className="input"
                              value={body}
                              maxLength={2000}
                              rows={5}
                              onChange={(e) => setBody(e.target.value)}
                            />
                          </label>
                          {problem && <Notice tone="bad">{problem}</Notice>}
                          <Button
                            variant="primary"
                            disabled={!body.trim() || sending}
                            onClick={appeal}
                          >
                            <MessageCircle size={16} />{" "}
                            {sending ? "Sending…" : "Send appeal"}
                          </Button>
                        </>
                      ) : (
                        <p>
                          Appeals are disabled. Contact your host through their
                          published support address.
                        </p>
                      )}
                    </Card>
                  </aside>
                </div>
              </>
            ) : (
              <section className="mews-account">
                {view !== "billing" && (
                  <h1 ref={heading} tabIndex={-1}>
                    {view === "billing"
                      ? "Billing"
                      : view === "data"
                        ? "Your data"
                        : "Account security"}
                  </h1>
                )}
                {view === "billing" ? (
                  <Billing />
                ) : view === "data" ? (
                  <AccountOptionsCard email={user.email} />
                ) : (
                  <>
                    <Card title="Password">
                      <Form
                        submit="Change password"
                        onSubmit={async (form) => {
                          await json("POST", "/auth/password", form);
                        }}
                      >
                        <Field
                          name="currentPassword"
                          label="Current password"
                          type="password"
                          required
                          autoComplete="current-password"
                        />
                        <Field
                          name="newPassword"
                          label="New password"
                          type="password"
                          required
                          autoComplete="new-password"
                        />
                        {user.has2fa && (
                          <Field
                            name="totp"
                            label="Authenticator code"
                            autoComplete="one-time-code"
                            required
                          />
                        )}
                      </Form>
                    </Card>
                    <AuthenticatorCard user={user} />
                    <PasskeysCard />
                    <SessionsCard />
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function AuthenticatorCard({ user }: { user: User }) {
  const current = useLoad<User>("/auth/me"),
    [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null),
    [codes, setCodes] = useState<string[]>([]);
  const enabled = current.data?.has2fa ?? user.has2fa;
  return (
    <Card title="Authenticator and recovery">
      <p>
        {enabled
          ? "Authenticator protection is enabled."
          : "Add an authenticator to protect sign-in."}
      </p>
      {!enabled && !setup && (
        <Button
          onClick={async () =>
            setSetup(await json("POST", "/auth/2fa/setup", {}))
          }
        >
          Set up authenticator
        </Button>
      )}
      {setup && (
        <>
          <p className="muted">
            Add this secret to your authenticator, then confirm its code.
          </p>
          <code className="mews-secret">{setup.secret}</code>
          <CopyButton value={setup.secret} label="Copy secret" />
          <Form
            submit="Confirm authenticator"
            onSubmit={async (form) => {
              await json("POST", "/auth/2fa/confirm", form);
              setSetup(null);
              current.reload();
            }}
          >
            <Field
              name="code"
              label="Authenticator code"
              required
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
            />
          </Form>
        </>
      )}
      <Form
        submit="Generate recovery codes"
        onSubmit={async (form) => {
          const r = await json("POST", "/auth/recovery-codes", form);
          setCodes(r.codes);
        }}
      >
        <Field
          name="password"
          label="Current password"
          type="password"
          required
          autoComplete="current-password"
        />
        {enabled && (
          <Field
            name="code"
            label="Authenticator code"
            pattern="[0-9]{6}"
            required
            autoComplete="one-time-code"
          />
        )}
      </Form>
      {codes.length > 0 && (
        <Notice title="Save these recovery codes">
          <pre>{codes.join("\n")}</pre>
          <CopyButton value={codes.join("\n")} label="Copy recovery codes" />
        </Notice>
      )}
    </Card>
  );
}
function SuspensionBackups({ servers }: { servers: Server[] }) {
  return (
    <Card title="Your backups">
      {servers.map((server) => (
        <BackupLinks key={server.id} server={server} />
      ))}
    </Card>
  );
}
function BackupLinks({ server }: { server: Server }) {
  const { data, error } = useLoad<any[]>(`/servers/${server.id}/backups`);
  return (
    <div>
      <strong>{server.name}</strong>
      {error && <p className="muted">{error}</p>}
      {data
        ?.filter((b) => b.state === "succeeded")
        .map((b) => (
          <p key={b.id}>
            <a
              href={`${API}/api/servers/${server.id}/backups/${b.id}/download`}
            >
              {fmtDay(b.createdAt || b.created_at)} \u00b7 Download backup
            </a>
          </p>
        ))}
      {data?.length === 0 && <p className="muted">No backups available.</p>}
    </div>
  );
}
