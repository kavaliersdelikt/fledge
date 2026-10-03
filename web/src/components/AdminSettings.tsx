"use client";

import { json, type EmailSettings, type SecuritySettings, type User } from "@/lib/api";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Card, ErrorNotice, Notice, Skeleton, Status, Switch, useLoad } from "./shared";
import { useToast } from "./toast";

type Settings = {
  storage: { enabled: boolean; endpoint: string; region: string; bucket: string; accessKey: string; forcePathStyle: boolean; secretKeySet: boolean };
  nodes: { allowedImagePrefixes: string[]; sftpEnabled: boolean; sftpPort: number; diskEnforcement: "auto" | "required" | "off" };
  agentUpdates: { auto: boolean; source: "github" | "url"; baseUrl: string };
  updates: { repository: string; githubTokenSet: boolean };
  failover: {
    enabled: boolean; graceMinutes: number; maxConcurrent: number; maxBackupAgeHours: number; allowWithoutBackup: boolean; sameLocationOnly: boolean; cooldownMinutes: number;
    protectionEnabled: boolean; protectionIntervalMinutes: number; selfFence: boolean; evictStaleData: boolean; evictedRetentionDays: number; webhookUrlSet: boolean;
  };
  email: EmailSettings;
  security: SecuritySettings;
  saved: Record<string, string>;
};

function Line({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </div>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

/** Saves one settings section. */
function useSave(section: string, reload: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(body: unknown, done = "Saved") {
    setBusy(true);
    setError("");
    try {
      await json("PUT", `/settings/${section}`, body);
      toast({ tone: "ok", title: done });
      reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, save };
}

function StorageCard({ value, reload }: { value: Settings["storage"]; reload: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ ...value, secretKey: "" });
  const [testing, setTesting] = useState(false),
    [testError, setTestError] = useState("");
  const { busy, error, save } = useSave("storage", reload);
  useEffect(() => setV({ ...value, secretKey: "" }), [value]);
  const set = (patch: Partial<typeof v>) => setV((p) => ({ ...p, ...patch }));
  const body = () => ({ ...v, secretKey: v.secretKey || undefined });

  async function test() {
    setTesting(true);
    setTestError("");
    try {
      const r = (await json("POST", "/settings/storage/test", body())) as { latencyMs: number };
      toast({ tone: "ok", title: "Storage works", description: `Wrote, read and deleted a test object in ${r.latencyMs} ms.` });
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card
      title="Object storage"
      description="Backups are kept in any S3-compatible bucket. File transfers don’t need it."
      actions={<Status value={value.enabled ? "active" : "stopped"} label={value.enabled ? "On" : "Off"} />}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(body(), v.enabled ? "Storage saved" : "Storage turned off");
        }}
      >
        <Toggle
          label="Use object storage for backups"
          hint="Backups, restores and scheduled backups stay unavailable while this is off."
          checked={v.enabled}
          onChange={(enabled) => set({ enabled })}
        />
        <div className="form-grid">
          <Line label="Bucket">
            <input className="input mono" value={v.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="fledge-backups" />
          </Line>
          <Line label="Region">
            <input className="input mono" value={v.region} onChange={(e) => set({ region: e.target.value })} placeholder="us-east-1" />
          </Line>
        </div>
        <Line label="Endpoint" hint="Leave empty for AWS S3. For MinIO, Backblaze, R2 and similar, enter their https:// address.">
          <input className="input mono" value={v.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://s3.example.com" />
        </Line>
        <div className="form-grid">
          <Line label="Access key">
            <input className="input mono" value={v.accessKey} autoComplete="off" onChange={(e) => set({ accessKey: e.target.value })} />
          </Line>
          <Line label="Secret key" hint={value.secretKeySet ? "A key is saved. Leave empty to keep it." : undefined}>
            <input
              className="input mono"
              type="password"
              value={v.secretKey}
              autoComplete="new-password"
              placeholder={value.secretKeySet ? "••••••••••••" : ""}
              onChange={(e) => set({ secretKey: e.target.value })}
            />
          </Line>
        </div>
        <Toggle
          label="Path-style addressing"
          hint="Keep on for MinIO and most self-hosted storage; turn off for AWS S3 buckets with dots in the name only if needed."
          checked={v.forcePathStyle}
          onChange={(forcePathStyle) => set({ forcePathStyle })}
        />
        <ErrorNotice message={error || testError} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
          <Button busy={testing} onClick={test}>
            Test connection
          </Button>
        </div>
      </form>
    </Card>
  );
}

function NodesCard({ value, reload }: { value: Settings["nodes"]; reload: () => void }) {
  const [v, setV] = useState({ ...value, images: value.allowedImagePrefixes.join("\n"), sftpPort: String(value.sftpPort) });
  const { busy, error, save } = useSave("nodes", reload);
  useEffect(() => setV({ ...value, images: value.allowedImagePrefixes.join("\n"), sftpPort: String(value.sftpPort) }), [value]);
  const set = (patch: Partial<typeof v>) => setV((p) => ({ ...p, ...patch }));
  return (
    <Card title="Game nodes" description="Applied to every connected node within seconds. No restart needed.">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            allowedImagePrefixes: v.images.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
            sftpEnabled: v.sftpEnabled,
            sftpPort: Number(v.sftpPort),
            diskEnforcement: v.diskEnforcement,
          });
        }}
      >
        <Line label="Allowed Docker images" hint="One image prefix per line. Templates and nodes refuse anything else.">
          <textarea className="input mono" rows={4} spellCheck={false} value={v.images} onChange={(e) => set({ images: e.target.value })} />
        </Line>
        <Toggle label="SFTP" hint="Players with file access can connect with temporary credentials." checked={v.sftpEnabled} onChange={(sftpEnabled) => set({ sftpEnabled })} />
        <Line label="SFTP port" hint="Open this port on each node’s firewall. Existing connections finish before the port moves.">
          <input className="input" type="number" min={1} max={65535} value={v.sftpPort} disabled={!v.sftpEnabled} onChange={(e) => set({ sftpPort: e.target.value })} />
        </Line>
        <Line
          label="Disk limits"
          hint="The kernel stops a server from writing past its disk allowance. “Automatic” falls back to soft limits on nodes that can’t do it; “Require” refuses to run servers there."
        >
          <select className="input select" value={v.diskEnforcement} onChange={(e) => set({ diskEnforcement: e.target.value as typeof v.diskEnforcement })}>
            <option value="auto">Enforce where the node supports it</option>
            <option value="required">Require enforcement</option>
            <option value="off">Don’t enforce (soft limits only)</option>
          </select>
        </Line>
        <ErrorNotice message={error} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}


function Num({ label, hint, value, onChange, min, max, disabled }: { label: string; hint?: ReactNode; value: number; onChange: (v: number) => void; min: number; max: number; disabled?: boolean }) {
  return (
    <Line label={label} hint={hint}>
      <input className="input" type="number" min={min} max={max} value={Number.isFinite(value) ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} />
    </Line>
  );
}

function FailoverCard({ value, storageOn, reload }: { value: Settings["failover"]; storageOn: boolean; reload: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ ...value, webhookUrl: "" });
  const [testing, setTesting] = useState(false),
    [testError, setTestError] = useState("");
  const { busy, error, save } = useSave("failover", reload);
  useEffect(() => setV({ ...value, webhookUrl: "" }), [value]);
  const set = (patch: Partial<typeof v>) => setV((p) => ({ ...p, ...patch }));
  async function test() {
    setTesting(true);
    setTestError("");
    try {
      await json("POST", "/settings/failover/test-webhook");
      toast({ tone: "ok", title: "Test message sent" });
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }
  return (
    <Card
      title="Automatic failover"
      description="When a node stays offline, its servers are rebuilt on another node from their newest backup."
      actions={<Status value={value.enabled ? "active" : "stopped"} label={value.enabled ? "On" : "Off"} />}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ ...v, webhookUrl: v.webhookUrl || undefined }, v.enabled ? "Failover saved" : "Failover turned off");
        }}
      >
        {!storageOn ? <Notice tone="warn">Object storage is off. Failover needs backups, so turn storage on first.</Notice> : null}
        <Toggle label="Fail over automatically" hint="Servers lose the data written since their last backup. The Resilience page shows how old that is." checked={v.enabled} onChange={(enabled) => set({ enabled })} />
        <div className="form-grid">
          <Num label="Wait before failing over (minutes)" hint="A node must be silent this long. Short waits recover faster but react to brief outages." value={v.graceMinutes} min={2} max={240} onChange={(graceMinutes) => set({ graceMinutes })} />
          <Num label="Recoveries at once" hint="Limits load on the surviving nodes." value={v.maxConcurrent} min={1} max={20} onChange={(maxConcurrent) => set({ maxConcurrent })} />
          <Num label="Oldest usable backup (hours)" hint="0 accepts any age." value={v.maxBackupAgeHours} min={0} max={8760} onChange={(maxBackupAgeHours) => set({ maxBackupAgeHours })} />
          <Num label="Pause between failovers of one server (minutes)" value={v.cooldownMinutes} min={1} max={10080} onChange={(cooldownMinutes) => set({ cooldownMinutes })} />
        </div>
        <Toggle label="Only fail over within the same location" checked={v.sameLocationOnly} onChange={(sameLocationOnly) => set({ sameLocationOnly })} />
        <Toggle label="Recover servers that have no backup, with empty data" hint="They start from scratch. Off keeps them down until a backup exists." checked={v.allowWithoutBackup} onChange={(allowWithoutBackup) => set({ allowWithoutBackup })} />
        <hr className="rule" />
        <Toggle label="Keep backups fresh" hint="Takes a backup of every protected running server on this interval. Only nodes with disk volumes are backed up this way, because it doesn’t stop the game." checked={v.protectionEnabled} onChange={(protectionEnabled) => set({ protectionEnabled })} />
        <Num label="Backup interval (minutes)" value={v.protectionIntervalMinutes} min={5} max={10080} disabled={!v.protectionEnabled} onChange={(protectionIntervalMinutes) => set({ protectionIntervalMinutes })} />
        <hr className="rule" />
        <Toggle label="Stop servers if a node loses the panel" hint="A node that can’t reach the panel for most of the waiting time stops its protected servers, so they can’t run twice if they are recovered elsewhere. If the panel itself is down, those servers stop too. They restart when it returns." checked={v.selfFence} onChange={(selfFence) => set({ selfFence })} />
        <Toggle label="Remove the old copy when a node returns" hint="The returning node drops servers that now live elsewhere." checked={v.evictStaleData} onChange={(evictStaleData) => set({ evictStaleData })} />
        <Num label="Keep removed data (days)" hint="Old copies are kept aside on the node for this long. 0 deletes them immediately." value={v.evictedRetentionDays} min={0} max={365} onChange={(evictedRetentionDays) => set({ evictedRetentionDays })} />
        <hr className="rule" />
        <Line label="Notification webhook" hint={value.webhookUrlSet ? "A webhook is saved. Leave empty to keep it. Works with Slack, Discord and Mattermost." : "Receives a message when a node goes offline or returns and when a server is recovered. Works with Slack, Discord and Mattermost."}>
          <input className="input mono" value={v.webhookUrl} autoComplete="off" placeholder={value.webhookUrlSet ? "••••••••••••" : "https://hooks.example.com/…"} onChange={(e) => set({ webhookUrl: e.target.value })} />
        </Line>
        <ErrorNotice message={error || testError} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
          <Button busy={testing} disabled={!value.webhookUrlSet} onClick={test}>
            Send test message
          </Button>
        </div>
      </form>
    </Card>
  );
}

const defaultPort = { none: 25, starttls: 587, tls: 465 } as const;

function EmailCard({ value, reload }: { value: Settings["email"]; reload: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ ...value, port: String(value.port), password: "" });
  const [to, setTo] = useState("");
  const [testing, setTesting] = useState(false),
    [testError, setTestError] = useState("");
  const { busy, error, save } = useSave("email", reload);
  const { data: me } = useLoad<User>("/auth/me");
  useEffect(() => setV({ ...value, port: String(value.port), password: "" }), [value]);
  useEffect(() => {
    if (me && !to) setTo(me.email);
  }, [me, to]);
  const set = (patch: Partial<typeof v>) => setV((p) => ({ ...p, ...patch }));
  async function test() {
    setTesting(true);
    setTestError("");
    try {
      await json("POST", "/settings/email/test", { to: to.trim() });
      toast({ tone: "ok", title: "Test email sent", description: `Check the inbox of ${to.trim()}.` });
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }
  return (
    <Card
      title="Email"
      description="Used for invitations, password resets and email notifications. Without it, invitations show a link you share yourself."
      actions={<Status value={value.enabled ? "active" : "stopped"} label={value.enabled ? "On" : "Off"} />}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(
            {
              enabled: v.enabled,
              host: v.host.trim(),
              port: Number(v.port),
              security: v.security,
              user: v.user.trim(),
              password: v.password || undefined,
              from: v.from.trim(),
            },
            v.enabled ? "Email settings saved" : "Email turned off",
          );
        }}
      >
        <Toggle label="Send email from the panel" hint="Turn off to keep your settings but stop all email." checked={v.enabled} onChange={(enabled) => set({ enabled })} />
        <div className="form-grid">
          <Line label="SMTP server">
            <input className="input mono" value={v.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.example.com" autoComplete="off" />
          </Line>
          <Line label="Port">
            <input className="input" type="number" min={1} max={65535} value={v.port} onChange={(e) => set({ port: e.target.value })} />
          </Line>
        </div>
        <Line label="Connection security" hint="STARTTLS (port 587) suits most providers; “TLS” (port 465) connects encrypted from the start. Only pick “None” on a trusted network.">
          <select
            className="input select"
            value={v.security}
            onChange={(e) => {
              const security = e.target.value as typeof v.security;
              const known = Object.values(defaultPort).map(String);
              set({ security, port: known.includes(v.port) ? String(defaultPort[security]) : v.port });
            }}
          >
            <option value="starttls">STARTTLS</option>
            <option value="tls">TLS (SSL)</option>
            <option value="none">None</option>
          </select>
        </Line>
        <div className="form-grid">
          <Line label="Username">
            <input className="input mono" value={v.user} autoComplete="off" onChange={(e) => set({ user: e.target.value })} />
          </Line>
          <Line label="Password" hint={value.passwordSet ? "A password is saved. Leave empty to keep it." : undefined}>
            <input
              className="input mono"
              type="password"
              value={v.password}
              autoComplete="new-password"
              placeholder={value.passwordSet ? "••••••••••••" : ""}
              onChange={(e) => set({ password: e.target.value })}
            />
          </Line>
        </div>
        <Line label="From address" hint="Shown as the sender, for example Fledge <panel@example.com>.">
          <input className="input" value={v.from} onChange={(e) => set({ from: e.target.value })} placeholder="Fledge <panel@example.com>" />
        </Line>
        <ErrorNotice message={error} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
        </div>
      </form>
      <hr className="rule" />
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void test();
        }}
      >
        <Line label="Send a test email" hint="Uses the saved settings, so save first.">
          <span className="input-group input-group--wide">
            <input className="input" type="email" required value={to} aria-label="Send the test email to" onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
            <Button type="submit" busy={testing} disabled={!value.enabled}>
              Send test email
            </Button>
          </span>
        </Line>
        <ErrorNotice message={testError} />
      </form>
    </Card>
  );
}

type Check = { yourAddress: string; allowed: boolean };

const entries = (t: string) => t.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

function SecurityCard({ value, reload }: { value: Settings["security"]; reload: () => void }) {
  const [text, setText] = useState(value.adminAllowedCidrs.join("\n"));
  const [days, setDays] = useState(value.auditRetentionDays);
  const [check, setCheck] = useState<Check | null>(null),
    [checkError, setCheckError] = useState("");
  const { busy, error, save } = useSave("security", reload);
  useEffect(() => {
    setText(value.adminAllowedCidrs.join("\n"));
    setDays(value.auditRetentionDays);
  }, [value]);
  // Re-check shortly after typing stops, so the hint tracks the list without a request per keystroke.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const r = (await json("POST", "/settings/security/check", { adminAllowedCidrs: entries(text) })) as Check;
        if (live) {
          setCheck(r);
          setCheckError("");
        }
      } catch (e) {
        if (live) setCheckError((e as Error).message);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);
  const open = entries(text).length === 0;
  return (
    <Card title="Security" description="Who can reach administrator features, and how long the audit log is kept.">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ adminAllowedCidrs: entries(text), auditRetentionDays: Number.isFinite(days) ? days : 0 }, "Security settings saved");
        }}
      >
        <Line
          label="Administrator IP allow-list"
          hint="One address or range per line, such as 203.0.113.7 or 10.0.0.0/8. Leave empty to allow administrators from anywhere. Customers aren’t affected."
        >
          <textarea className="input mono" rows={4} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={"203.0.113.7\n10.0.0.0/8"} aria-describedby="allowlist-status" />
        </Line>
        <p id="allowlist-status" className="allow-status" aria-live="polite">
          {checkError ? (
            <span className="status status--bad">
              <span className="status__dot" aria-hidden="true" />
              {checkError}
            </span>
          ) : check ? (
            <span className={`status status--${check.allowed ? "ok" : "bad"}`}>
              <span className="status__dot" aria-hidden="true" />
              Your address: <code>{check.yourAddress}</code> — {check.allowed ? (open ? "allowed (no list)" : "allowed") : "not allowed"}
            </span>
          ) : (
            <span className="faint small">Checking your address…</span>
          )}
        </p>
        {check && !check.allowed && !checkError ? (
          <Notice tone="warn">This list would lock you out, so the panel will refuse to save it. Add your own address first.</Notice>
        ) : null}
        <Num label="Keep the audit log for (days)" hint="0 keeps everything. Older entries are deleted automatically." value={days} min={0} max={36500} onChange={setDays} />
        <ErrorNotice message={error} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

function UpdatesCard({ agent, panel, reload }: { agent: Settings["agentUpdates"]; panel: Settings["updates"]; reload: () => void }) {
  const [a, setA] = useState({ ...agent });
  const [p, setP] = useState({ repository: panel.repository, githubToken: "" });
  const agentSave = useSave("agentUpdates", reload),
    panelSave = useSave("updates", reload);
  useEffect(() => setA({ ...agent }), [agent]);
  useEffect(() => setP({ repository: panel.repository, githubToken: "" }), [panel]);
  return (
    <Card title="Updates" description="Where the panel and its node agents look for new versions.">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void panelSave.save({ repository: p.repository, githubToken: p.githubToken || undefined });
        }}
      >
        <Line label="GitHub repository" hint="Releases are read from here.">
          <input className="input mono" value={p.repository} onChange={(e) => setP({ ...p, repository: e.target.value })} placeholder="owner/fledge" />
        </Line>
        <Line label="GitHub token" hint={panel.githubTokenSet ? "A token is saved. Leave empty to keep it." : "Only needed for private repositories or to avoid rate limits."}>
          <input className="input mono" type="password" autoComplete="new-password" value={p.githubToken} placeholder={panel.githubTokenSet ? "••••••••••••" : ""} onChange={(e) => setP({ ...p, githubToken: e.target.value })} />
        </Line>
        <ErrorNotice message={panelSave.error} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={panelSave.busy}>
            Save
          </Button>
        </div>
      </form>
      <hr className="rule" />
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void agentSave.save({ ...a, baseUrl: a.baseUrl });
        }}
      >
        <Toggle label="Update node agents automatically" hint="Connected nodes install new agent versions as soon as they’re published." checked={a.auto} onChange={(auto) => setA({ ...a, auto })} />
        <Line label="Agent release source">
          <select className="input select" value={a.source} onChange={(e) => setA({ ...a, source: e.target.value as "github" | "url" })}>
            <option value="github">GitHub release of the repository above</option>
            <option value="url">My own download URL</option>
          </select>
        </Line>
        {a.source === "url" ? (
          <Line label="Download URL" hint="Must serve VERSION, SHA256SUMS and fledge-agent_linux_amd64 / _arm64.">
            <input className="input mono" value={a.baseUrl} onChange={(e) => setA({ ...a, baseUrl: e.target.value })} placeholder="https://downloads.example.com/fledge" />
          </Line>
        ) : null}
        <ErrorNotice message={agentSave.error} />
        <div className="form__actions">
          <Button type="submit" variant="primary" busy={agentSave.busy}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function AdminSettings() {
  const { data, error, loading, reload } = useLoad<Settings>("/settings");
  if (loading) return <Skeleton rows={3} />;
  if (error || !data) return <ErrorNotice message={error || "Settings could not be loaded."} />;
  const unsaved = Object.keys(data.saved).length === 0;
  return (
    <div className="stack">
      {unsaved ? (
        <Notice>Nothing is saved yet, so the panel is using the values from its install. Saving a section here takes over from them.</Notice>
      ) : null}
      <StorageCard value={data.storage} reload={reload} />
      <NodesCard value={data.nodes} reload={reload} />
      <FailoverCard value={data.failover} storageOn={data.storage.enabled} reload={reload} />
      <EmailCard value={data.email} reload={reload} />
      <SecurityCard value={data.security} reload={reload} />
      <UpdatesCard agent={data.agentUpdates} panel={data.updates} reload={reload} />
    </div>
  );
}
