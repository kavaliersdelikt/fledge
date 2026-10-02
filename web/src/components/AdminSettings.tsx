"use client";

import { json } from "@/lib/api";
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
      <UpdatesCard agent={data.agentUpdates} panel={data.updates} reload={reload} />
    </div>
  );
}
