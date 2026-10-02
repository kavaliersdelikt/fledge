"use client";

import { items, request, type Job, type Node, type Server } from "@/lib/api";
import { fmtAction, fmtAgo, fmtCpuPair, fmtMbPair, fmtTime } from "@/lib/format";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import DataTable, { type DataColumn } from "./DataTable";
import { Num } from "./motion";
import { CpuCell, MemoryCell, liveUsage } from "./ServerUsage";
import { Card, Empty, ErrorNotice, Meter, Notice, PageHeader, Skeleton, btn } from "./shared";

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
  target_id?: string;
};

const loadColumns: DataColumn<Server>[] = [
  {
    id: "name",
    header: "Server",
    value: (s) => s.name,
    render: (s) => (
      <div className="cell-main">
        <Link href={`/servers/${s.id}`}>{s.name}</Link>
        <small>{s.nodeName}</small>
      </div>
    ),
  },
  { id: "cpu", header: "CPU", width: "170px", value: (s) => liveUsage(s)?.cpu ?? -1, render: (s) => <CpuCell server={s} /> },
  { id: "memory", header: "Memory", width: "190px", value: (s) => liveUsage(s)?.mem ?? -1, render: (s) => <MemoryCell server={s} /> },
];

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [fleet, setFleet] = useState<Server[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [overview, activity, servers, recentJobs] = await Promise.all([
        request<OverviewData>("/overview"),
        request<Event[]>("/activity?limit=30"),
        request<Server[]>("/servers?limit=100&offset=0"),
        request<Job[]>("/jobs?limit=100"),
      ]);
      setData(overview);
      setEvents(items(activity).filter((e) => e.action !== "login").slice(0, 7));
      setFleet(items(servers));
      setJobs(items(recentJobs));
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

  const nodes = data?.capacity || [];
  const total = fleet.length;
  const running = fleet.filter((s) => s.status === "running");
  const failed = fleet.filter((s) => ["failed", "missing"].includes(s.status));
  const offline = nodes.filter((n) => n.status !== "connected" && n.lastSeenAt);
  const waiting = nodes.filter((n) => n.status !== "connected" && !n.lastSeenAt);
  const names: Record<string, string> = {
    ...Object.fromEntries(fleet.map((s) => [s.id, s.name])),
    ...Object.fromEntries(nodes.map((n) => [n.id, n.name])),
  };
  const lastError = (serverId: string) => jobs.find((j) => j.serverId === serverId && j.state === "failed")?.error;
  const sum = (key: "memoryMb" | "cpuPercent" | "diskMb", kind: "capacity" | "reserved") =>
    nodes.reduce((acc, node) => acc + node[kind][key], 0);
  const busiest = [...running].sort((a, b) => (liveUsage(b)?.cpu ?? 0) - (liveUsage(a)?.cpu ?? 0));

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          data ? (
            <>
              <Num value={running.length} /> of {total} servers running
            </>
          ) : undefined
        }
        actions={
          <Link href="/servers?new=1" className={btn("primary")}>
            <Plus /> New server
          </Link>
        }
      />

      <ErrorNotice message={error} />

      {!data ? (
        !error && <Skeleton rows={6} />
      ) : (
        <>
          {offline.map((n) => {
            const affected = fleet.filter((s) => s.nodeId === n.id).length;
            return (
              <Notice
                key={n.id}
                tone="warn"
                title={`${n.name} is offline`}
                action={
                  <Link href="/nodes" className={btn("secondary", "sm")}>
                    Nodes
                  </Link>
                }
              >
                Last seen {fmtAgo(n.lastSeenAt)}
                {affected ? ` · ${affected} ${affected === 1 ? "server" : "servers"} unreachable` : ""}
              </Notice>
            );
          })}
          {waiting.map((n) => (
            <Notice
              key={n.id}
              title={`${n.name} is waiting for its agent`}
              action={
                <Link href={`/nodes?connect=${n.id}`} className={btn("secondary", "sm")}>
                  Connect
                </Link>
              }
            />
          ))}
          {failed.map((s) => (
            <Notice
              key={s.id}
              tone="bad"
              title={`${s.name} failed`}
              action={
                <Link href={`/servers/${s.id}?tab=jobs`} className={btn("secondary", "sm")}>
                  Open
                </Link>
              }
            >
              {lastError(s.id) || "Its last job didn’t complete."}
            </Notice>
          ))}

          <Card flush>
            <div className="capacity-totals">
              {(
                [
                  ["Memory", "memoryMb", fmtMbPair],
                  ["CPU", "cpuPercent", fmtCpuPair],
                  ["Disk", "diskMb", fmtMbPair],
                ] as const
              ).map(([label, key, pair]) => {
                const used = sum(key, "reserved");
                const cap = sum(key, "capacity");
                return (
                  <div className="capacity-total" key={key}>
                    <header>
                      <span>{label} reserved</span>
                      <strong>
                        <Num value={cap ? Math.round((used / cap) * 100) : 0} />%
                      </strong>
                    </header>
                    <Meter value={used} max={cap} label={`${label} reserved`} />
                    <small>{pair(used, cap)}</small>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid-2">
            <Card title="Running now" flush>
              {busiest.length ? (
                <DataTable
                  data={busiest.slice(0, 8)}
                  columns={loadColumns}
                  rowKey={(s) => s.id}
                  rowHref={(s) => `/servers/${s.id}`}
                />
              ) : (
                <Empty
                  title={total ? "Nothing is running" : "No servers yet"}
                  action={
                    total ? undefined : (
                      <Link href="/servers?new=1" className={btn("secondary", "sm")}>
                        Create a server
                      </Link>
                    )
                  }
                />
              )}
            </Card>
            <Card title="Recent changes" flush>
              {events.length ? (
                <div className="feed">
                  {events.map((e, i) => (
                    <div className="feed__row" key={e.id} style={{ ["--i" as string]: i }}>
                      <span>
                        {fmtAction(e.action)}
                        {e.target_id && names[e.target_id] ? <small>{names[e.target_id]}</small> : null}
                      </span>
                      <time dateTime={e.created_at} title={fmtTime(e.created_at)}>
                        {fmtAgo(e.created_at)}
                      </time>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="No changes yet" />
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
