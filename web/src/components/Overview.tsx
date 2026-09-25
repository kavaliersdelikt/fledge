"use client";

import { fmtDate, items, request, type Node, type Server } from "@/lib/api";
import {
  ArrowUpRight,
  HardDrive,
  RefreshCw,
  Server as ServerIcon,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Notice } from "./shared";

type OverviewData = {
  nodes: Record<string, number>;
  servers: Record<string, number>;
  customers: number;
  failedJobs: number;
  capacity: Node[];
};

type Event = {
  id: string;
  action: string;
  created_at: string;
  target_type: string;
};

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overview, activity, fleet] = await Promise.all([
        request<OverviewData>("/overview"),
        request<Event[]>("/activity?limit=5"),
        request<Server[]>("/servers?limit=6&offset=0"),
      ]);
      setData(overview);
      setEvents(activity);
      setServers(items(fleet));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);

  async function refreshNow() {
    setBusy(true);
    await load();
    setBusy(false);
  }

  const nodes = data?.capacity || [];
  const offline = nodes.filter((node) => node.status !== "connected");
  const totalServers = data
    ? Object.values(data.servers).reduce((total, count) => total + count, 0)
    : 0;
  const sum = (
    key: "memoryMb" | "cpuPercent" | "diskMb",
    kind: "capacity" | "reserved",
  ) => nodes.reduce((total, node) => total + node[kind][key], 0);

  return (
    <>
      <div className="heading overview-heading">
        <div>
          <div className="eyebrow">Workspace / Overview</div>
          <h1>Infrastructure</h1>
          <p className="muted">A live view of your servers and hosts.</p>
        </div>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={refreshNow}>
            <RefreshCw size={15} className={busy ? "spin" : ""} />
            {busy ? "Updating" : "Refresh"}
          </button>
          <Link href="/servers" className="btn primary">
            <ServerIcon size={15} />
            Open servers
          </Link>
        </div>
      </div>

      {error && <Notice status="danger" title="Dashboard refresh failed">{error}</Notice>}

      {!data ? (
        !error && <div className="skeleton overview-skeleton" aria-label="Loading infrastructure" />
      ) : (
        <>
          <section className="overview-counts" aria-label="Workspace totals">
            <Link className="overview-count overview-count--lead" href="/servers">
              <span>Running servers</span>
              <strong>{(data.servers.running || 0).toLocaleString()}</strong>
              <small>of {totalServers.toLocaleString()} total</small>
            </Link>
            <Link className="overview-count" href="/nodes">
              <span>Connected hosts</span>
              <strong>{(data.nodes.connected || 0).toLocaleString()}</strong>
              <small>{nodes.length} registered</small>
            </Link>
            <Link className="overview-count" href="/customers">
              <span>Customers</span>
              <strong>{data.customers.toLocaleString()}</strong>
              <small>Workspace accounts</small>
            </Link>
            <Link className="overview-count" href="/activity">
              <span>Failed jobs</span>
              <strong className={data.failedJobs ? "count-warning" : ""}>
                {data.failedJobs.toLocaleString()}
              </strong>
              <small>Across the fleet</small>
            </Link>
          </section>

          {(offline.length > 0 || (data.servers.unreachable || 0) > 0) && (
            <Notice status="warning" className="dashboard-notice" title="Infrastructure needs attention">
              <span>
                {offline.length} {offline.length === 1 ? "host is" : "hosts are"} disconnected
                {data.servers.unreachable
                  ? ` · ${data.servers.unreachable} ${data.servers.unreachable === 1 ? "server is" : "servers are"} unreachable`
                  : ""}.
              </span>
              <Link href="/nodes" className="notice-link">Review hosts <ArrowUpRight size={13} /></Link>
            </Notice>
          )}
          {data.failedJobs > 0 && (
            <Notice status="warning" className="dashboard-notice" title="Failed jobs need review">
              <span>{data.failedJobs} jobs have failed across the workspace.</span>
              <Link href="/servers" className="notice-link">Review server jobs <ArrowUpRight size={13} /></Link>
            </Notice>
          )}

          <div className="overview-main-grid">
            <section className="section fleet-section">
              <div className="section-title">
                <div>
                  <span className="eyebrow">Fleet</span>
                  <h2>Recently updated servers</h2>
                  <p className="muted">Status is refreshed automatically.</p>
                </div>
                <Link className="link" href="/servers">All servers <ArrowUpRight size={14} /></Link>
              </div>
              {servers.length ? (
                <div className="fleet-list">
                  {servers.slice(0, 6).map((server) => (
                    <Link href={`/servers/${server.id}`} className="fleet-row" key={server.id}>
                      <span className={`fleet-state fleet-state--${server.status}`} aria-hidden="true" />
                      <span className="fleet-row-main">
                        <strong>{server.name}</strong>
                        <small>{server.templateId} · {server.nodeName || server.location || "No host assigned"}</small>
                      </span>
                      <span className={`fleet-status fleet-status--${server.status}`}>{server.status}</span>
                      <ArrowUpRight size={14} className="fleet-arrow" />
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="empty fleet-empty">
                  <ServerIcon size={23} />
                  <h3>No servers yet</h3>
                  <p>Create a server once a connected host is available.</p>
                  <Link href="/servers" className="link">Go to servers <ArrowUpRight size={14} /></Link>
                </div>
              )}
            </section>

            <div className="overview-rail">
              <section className="section capacity-section">
                <div className="section-title">
                  <div>
                    <span className="eyebrow">Capacity</span>
                    <h2>Reserved resources</h2>
                  </div>
                  <Link className="link" href="/nodes">Hosts <ArrowUpRight size={14} /></Link>
                </div>
                {(
                  [
                    { key: "memoryMb", label: "Memory", unit: "GB", divisor: 1024 },
                    { key: "cpuPercent", label: "CPU", unit: "%", divisor: 1 },
                    { key: "diskMb", label: "Disk", unit: "GB", divisor: 1024 },
                  ] as const
                ).map((resource) => {
                  const used = sum(resource.key, "reserved");
                  const capacity = sum(resource.key, "capacity");
                  const percent = capacity ? Math.round((used / capacity) * 100) : 0;
                  return (
                    <div className="resource-line" key={resource.key}>
                      <header>
                        <strong>{resource.label}</strong>
                        <span className="mono">{percent}% <small>reserved</small></span>
                      </header>
                      <div className="meter" role="meter" aria-label={`${resource.label} reserved`} aria-valuenow={used} aria-valuemin={0} aria-valuemax={Math.max(1, used, capacity)}>
                        <span style={{ width: `${Math.min(100, percent)}%` }} />
                      </div>
                      <footer>
                        <span>{(used / resource.divisor).toLocaleString(undefined, { maximumFractionDigits: 1 })} {resource.unit}</span>
                        <span>{(capacity / resource.divisor).toLocaleString(undefined, { maximumFractionDigits: 1 })} total</span>
                      </footer>
                    </div>
                  );
                })}
                <p className="section-footnote">Allocated capacity, not live usage.</p>
              </section>

              <section className="section node-section">
                <div className="section-title">
                  <div>
                    <span className="eyebrow">Hosts</span>
                    <h2>Node health</h2>
                  </div>
                  <Link className="link" href="/nodes">View all <ArrowUpRight size={14} /></Link>
                </div>
                {nodes.length ? (
                  <div className="health-list">
                    {nodes.slice(0, 4).map((node) => (
                      <Link href="/nodes" className="health-row" key={node.id}>
                        <span className="entity-icon"><HardDrive size={16} /></span>
                        <span className="health-row-copy">
                          <strong>{node.name}</strong>
                          <small>{node.location}</small>
                        </span>
                        <span className={`badge ${node.status === "connected" ? "good" : "bad"}`}>
                          <span className="dot" />
                          {node.status !== "connected" ? "Disconnected" : node.draining ? "Draining" : "Connected"}
                        </span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="empty node-empty">
                    <HardDrive size={23} />
                    <p>No hosts registered.</p>
                    <Link href="/nodes" className="link">Connect a host <ArrowUpRight size={14} /></Link>
                  </div>
                )}
              </section>
            </div>

            <section className="section activity-summary">
              <div className="section-title">
                <div>
                  <span className="eyebrow">Workspace log</span>
                  <h2>Recent activity</h2>
                </div>
                <Link href="/activity" className="link">Full activity <ArrowUpRight size={14} /></Link>
              </div>
              <div className="event-list">
                {events.length ? events.map((event) => (
                  <div className="event-row" key={event.id}>
                    <span className="event-rail" aria-hidden="true" />
                    <div>
                      <strong>{event.action.replaceAll(".", " / ")}</strong>
                      <small>{event.target_type}</small>
                    </div>
                    <time>{fmtDate(event.created_at)}</time>
                  </div>
                )) : <div className="empty">New workspace activity will appear here.</div>}
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
