"use client";

import { json } from "@/lib/api";
import { fmtAgo, fmtTime } from "@/lib/format";
import { ArrowRightLeft, FlaskConical, Settings } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Modal, useConfirm } from "./feedback";
import { Button, Card, Empty, Notice, PageHeader, State, Status, Switch, useLoad } from "./shared";
import { useToast } from "./toast";

type FailoverStatus = {
  settings: { enabled: boolean; graceMinutes: number; maxBackupAgeHours: number; protectionEnabled: boolean; selfFence: boolean; webhook: boolean };
  storageEnabled: boolean;
  nodes: { id: string; name: string; location: string; status: string; draining: boolean; lastSeenAt: string | null; silentForSeconds: number | null; servers: number; snapshots: boolean; failoverInSeconds: number | null }[];
  servers: { id: string; name: string; nodeId: string; nodeName: string; failoverEnabled: boolean; status: string; lastBackupAt: string | null; backupAgeSeconds: number | null; protected: boolean; issues: string[] }[];
  events: Event[];
  nodeHistory: { id: number; kind: "down" | "up"; at: string; nodeName: string }[];
  stats: { recovered24h: number; failed24h: number; averageRecoverySeconds: number; averageDataAgeSeconds: number; protectedServers: number; totalServers: number; active: number };
};
type Event = {
  id: string;
  serverId: string;
  serverName: string | null;
  kind: "failover" | "migration";
  state: "blocked" | "backing-up" | "restoring" | "completed" | "failed";
  reason: string;
  fromNodeName: string | null;
  toNodeName: string | null;
  dataAgeSeconds: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
type Plan = { node: string; servers: { serverId: string; serverName: string; ok: boolean; blockers: string[]; targetNode?: string | null; backupAgeSeconds?: number | null }[] };

function dur(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}
const eventTone: Record<string, "ok" | "bad" | "warn" | "busy"> = { completed: "ok", failed: "bad", blocked: "warn", "backing-up": "busy", restoring: "busy" };
const eventLabel: Record<string, string> = { completed: "Done", failed: "Failed", blocked: "Waiting", "backing-up": "Backing up", restoring: "Restoring" };

export default function Resilience() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad<FailoverStatus>("/failover/status", 5000);
  const [plan, setPlan] = useState<Plan | null>(null),
    [planning, setPlanning] = useState("");

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast({ tone: "ok", title: done });
      reload();
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    }
  }
  async function simulate(nodeId: string) {
    setPlanning(nodeId);
    try {
      setPlan((await json("POST", "/failover/plan", { nodeId })) as Plan);
    } catch (e) {
      toast({ tone: "bad", title: "That didn’t work", description: (e as Error).message });
    } finally {
      setPlanning("");
    }
  }

  const nodeColumns: DataColumn<FailoverStatus["nodes"][number]>[] = [
    {
      id: "name",
      header: "Node",
      value: (n) => n.name,
      render: (n) => (
        <div className="cell-main">
          <strong>{n.name}</strong>
          <small>
            {n.location}
            {n.snapshots ? " · snapshot backups" : ""}
          </small>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      value: (n) => n.status,
      render: (n) =>
        n.status === "connected" ? (
          <Status value={n.draining ? "draining" : "connected"} />
        ) : n.failoverInSeconds !== null ? (
          <Status value="disconnected" label={n.failoverInSeconds > 0 ? `Offline · failover in ${dur(n.failoverInSeconds)}` : "Offline · recovering servers"} />
        ) : (
          <Status value="disconnected" />
        ),
    },
    { id: "seen", header: "Last seen", optional: true, value: (n) => n.lastSeenAt || "", render: (n) => <span className="muted">{n.lastSeenAt ? fmtAgo(n.lastSeenAt) : "never"}</span> },
    { id: "servers", header: "Servers", optional: true, value: (n) => n.servers, render: (n) => <span className="muted">{n.servers}</span> },
    {
      id: "actions",
      header: "",
      align: "end",
      sortable: false,
      value: () => "",
      render: (n) => (
        <span className="row-actions">
          <Button size="sm" variant="ghost" busy={planning === n.id} onClick={() => void simulate(n.id)} disabled={!n.servers}>
            <FlaskConical /> Simulate failure
          </Button>
          {n.status === "connected" && n.servers ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (await confirm(`Every server on ${n.name} is stopped, backed up and rebuilt on other nodes, one after another. New servers stop being placed there.`, { danger: false, confirmLabel: "Move everything", title: `Empty ${n.name}?` }))
                  void act(() => json("POST", `/nodes/${n.id}/evacuate`), `Emptying ${n.name}`);
              }}
            >
              Empty node
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  const serverColumns: DataColumn<FailoverStatus["servers"][number]>[] = [
    {
      id: "name",
      header: "Server",
      value: (s) => s.name,
      render: (s) => (
        <div className="cell-main">
          <Link href={`/servers/${s.id}`}>
            <strong>{s.name}</strong>
          </Link>
          <small>{s.nodeName}</small>
        </div>
      ),
    },
    {
      id: "protection",
      header: "Recovery",
      value: (s) => (s.protected ? 1 : 0),
      render: (s) =>
        s.protected ? (
          <Status value="active" label="Ready" />
        ) : (
          <span title={s.issues.join("\n")}>
            <Status value="warn" tone="warn" label={s.issues[0] || "Not ready"} />
          </span>
        ),
    },
    {
      id: "backup",
      header: "Newest backup",
      optional: true,
      value: (s) => s.backupAgeSeconds ?? Number.MAX_SAFE_INTEGER,
      render: (s) => (s.lastBackupAt ? <span className="muted" title={fmtTime(s.lastBackupAt)}>{fmtAgo(s.lastBackupAt)}</span> : <span className="faint">None</span>),
    },
    {
      id: "enabled",
      header: "Failover",
      align: "end",
      sortable: false,
      value: () => "",
      render: (s) => (
        <span className="row-actions">
          <Switch
            label={`Failover for ${s.name}`}
            checked={s.failoverEnabled}
            onChange={(enabled) => void act(() => json("PATCH", `/servers/${s.id}/failover`, { enabled }), enabled ? `Failover on for ${s.name}` : `Failover off for ${s.name}`)}
          />
          <Button
            size="sm"
            variant="ghost"
            className="row-hover"
            onClick={async () => {
              if (await confirm(`${s.name} is stopped, backed up, and rebuilt on another node. Expect a few minutes of downtime and nothing lost.`, { danger: false, confirmLabel: "Move server", title: `Move ${s.name}?` }))
                void act(() => json("POST", `/servers/${s.id}/migrate`), `Moving ${s.name}`);
            }}
          >
            <ArrowRightLeft /> Move
          </Button>
        </span>
      ),
    },
  ];

  const eventColumns: DataColumn<Event>[] = [
    {
      id: "when",
      header: "When",
      value: (e) => e.startedAt,
      render: (e) => <time className="muted" title={fmtTime(e.startedAt)}>{fmtAgo(e.startedAt)}</time>,
    },
    {
      id: "what",
      header: "Event",
      value: (e) => `${e.serverName} ${e.kind}`,
      render: (e) => (
        <div className="cell-main">
          <strong>
            {e.serverName || "Deleted server"} · {e.kind === "migration" ? "Move" : "Failover"}
          </strong>
          <small>
            {e.error || (e.state === "blocked" ? e.reason : e.fromNodeName && e.toNodeName ? `${e.fromNodeName} → ${e.toNodeName}${e.dataAgeSeconds !== null ? ` · backup ${dur(e.dataAgeSeconds)} old` : ""}` : e.reason)}
          </small>
        </div>
      ),
    },
    {
      id: "state",
      header: "",
      align: "end",
      value: (e) => e.state,
      render: (e) => (
        <span className="row-actions">
          <Status value={e.state} tone={eventTone[e.state]} label={eventLabel[e.state]} />
          {e.state === "blocked" || e.state === "failed" ? (
            <Button size="sm" variant="ghost" className="row-hover" onClick={() => void act(() => json("POST", `/failover/events/${e.id}/dismiss`), "Dismissed")}>
              Dismiss
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Resilience"
        actions={
          <Link href="/settings" className="btn btn--secondary">
            <Settings /> Failover settings
          </Link>
        }
      />
      <State loading={loading} error={error} rows={6}>
        {data ? (
          <div className="stack">
            {!data.settings.enabled ? (
              <Notice tone="warn" title="Automatic failover is off">
                If a node dies, its servers stay down until you move them yourself. Turn it on in Settings → Panel → Failover.
              </Notice>
            ) : null}
            {data.settings.enabled && !data.storageEnabled ? (
              <Notice tone="bad" title="Object storage is off">
                Failover restores servers from backups, so nothing can be recovered until storage is on.
              </Notice>
            ) : null}
            {data.stats.active > 0 ? (
              <Notice tone="busy" title={`${data.stats.active} ${data.stats.active === 1 ? "recovery is" : "recoveries are"} running`}>
                The list below updates as steps finish.
              </Notice>
            ) : null}

            <section className="stats" aria-label="Summary">
              <div className="stat">
                <span>Ready to recover</span>
                <strong>
                  {data.stats.protectedServers} <small>of {data.stats.totalServers}</small>
                </strong>
              </div>
              <div className="stat">
                <span>Recovered, last 24 h</span>
                <strong>
                  {data.stats.recovered24h}
                  {data.stats.failed24h ? <small> · {data.stats.failed24h} failed</small> : null}
                </strong>
              </div>
              <div className="stat">
                <span>Typical recovery time</span>
                <strong>{data.stats.averageRecoverySeconds ? dur(data.stats.averageRecoverySeconds) : "—"}</strong>
              </div>
              <div className="stat">
                <span>Typical data age</span>
                <strong>{data.stats.averageDataAgeSeconds ? dur(data.stats.averageDataAgeSeconds) : "—"}</strong>
              </div>
            </section>

            <Card title="Nodes" description={data.settings.enabled ? `Servers move after a node has been silent for ${data.settings.graceMinutes} minutes.` : undefined} flush>
              <DataTable data={data.nodes} columns={nodeColumns} rowKey={(n) => n.id} empty="No nodes yet." />
            </Card>

            <Card title="Servers" flush>
              <DataTable data={data.servers} columns={serverColumns} rowKey={(s) => s.id} empty="No servers yet." />
            </Card>

            <Card title="Recoveries" description="Automatic failovers and planned moves." flush>
              {data.events.length ? <DataTable data={data.events} columns={eventColumns} rowKey={(e) => e.id} /> : <Empty title="Nothing has needed recovering" />}
            </Card>

            {data.nodeHistory.length ? (
              <Card title="Node history" flush>
                <div className="log">
                  {data.nodeHistory.map((h, i) => (
                    <div className="log__row" key={h.id} style={{ ["--i" as string]: i }}>
                      <time dateTime={h.at} title={fmtTime(h.at)}>
                        {fmtAgo(h.at)}
                      </time>
                      <span className="log__what">
                        {h.nodeName} {h.kind === "down" ? "went offline" : "came back"}
                      </span>
                      <span className="log__by" />
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </div>
        ) : null}
      </State>

      <Modal
        open={!!plan}
        onOpenChange={(o) => !o && setPlan(null)}
        title={plan ? `If ${plan.node} went down now` : "Simulation"}
        description="Nothing is changed. This is what an automatic failover would do with the current settings."
        wide
      >
        {plan ? (
          <div className="stack">
            {plan.servers.map((s) => (
              <div key={s.serverId} className="plan-row">
                <div>
                  <strong>{s.serverName}</strong>
                  <small>{s.ok ? `Would restart on ${s.targetNode}${s.backupAgeSeconds !== null && s.backupAgeSeconds !== undefined ? ` from a backup ${dur(s.backupAgeSeconds)} old` : " with empty data"}` : s.blockers.join(" · ")}</small>
                </div>
                <Status value={s.ok ? "active" : "warn"} tone={s.ok ? "ok" : "warn"} label={s.ok ? "Would recover" : "Would stay down"} />
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
