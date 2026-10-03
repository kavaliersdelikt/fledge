"use client";
import { request, type Server, type ServerMetrics } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Sparkline, type Point } from "./charts";
import { ErrorNotice, Segmented } from "./shared";
import type { Sample } from "./useLiveServer";

type Range = "live" | "1h" | "6h" | "24h" | "7d" | "30d";
const ranges: { value: Range; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];
const REFRESH_MS = 60_000;
const EMPTY = "No history yet — samples appear while the server runs";

const timeLabel = (t: number, range: Range) =>
  new Date(t).toLocaleString([], range === "7d" || range === "30d" ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
const axisLabel = (t: number, range: Range) =>
  new Date(t).toLocaleString([], range === "7d" || range === "30d" ? { month: "short", day: "numeric" } : range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/** CPU and memory over time. Collapsed until opened, so nothing is fetched for people who never look. */
export default function UsageHistory({ server, samples }: { server: Server; samples: Sample[] }) {
  const [open, setOpen] = useState(false),
    [range, setRange] = useState<Range>("live");
  return (
    <details className="usage-history" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <ChevronDown aria-hidden="true" />
        Usage history
      </summary>
      {open ? (
        <div className="usage-history__body">
          <Segmented label="Time range" value={range} onChange={setRange} options={ranges} />
          {range === "live" ? <Charts server={server} range="live" live={samples} /> : <History server={server} range={range} />}
        </div>
      ) : null}
    </details>
  );
}

function History({ server, range }: { server: Server; range: Exclude<Range, "live"> }) {
  const [data, setData] = useState<ServerMetrics | null>(null),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      request<ServerMetrics>(`/servers/${server.id}/metrics?range=${range}`)
        .then((r) => {
          if (!live) return;
          setData(r);
          setError("");
          setLoaded(range);
        })
        .catch((e) => live && setError((e as Error).message));
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [server.id, range]);
  if (error && !data) return <ErrorNotice message={error} />;
  if (!data || loaded !== range) return <div className="skeleton" role="status" aria-label="Loading"><span /><span /></div>;
  return <Charts server={server} range={range} metrics={data} />;
}

function Charts({ server, range, metrics, live }: { server: Server; range: Range; metrics?: ServerMetrics; live?: Sample[] }) {
  const cpuLimit = Math.max(1, server.cpuPercent);
  const memLimit = metrics?.memoryLimitBytes || server.memoryMb * 1024 * 1024;
  const { cpu, mem, peakCpu, peakMem } = useMemo(() => {
    if (metrics) {
      return {
        cpu: metrics.points.map((p): Point => ({ t: p.t, v: (p.cpu / cpuLimit) * 100 })),
        mem: metrics.points.map((p): Point => ({ t: p.t, v: (p.memory / memLimit) * 100 })),
        peakCpu: Math.max(0, ...metrics.points.map((p) => (p.cpuMax / cpuLimit) * 100)),
        peakMem: Math.max(0, ...metrics.points.map((p) => (p.memoryMax / memLimit) * 100)),
      };
    }
    const recent = (live || []).filter((p) => Date.now() - p.t < 5 * 60_000);
    return {
      cpu: recent.map((p): Point => ({ t: p.t, v: (p.cpu / cpuLimit) * 100 })),
      mem: recent.map((p): Point => ({ t: p.t, v: (p.mem / (p.memLimit || memLimit)) * 100 })),
      peakCpu: Math.max(0, ...recent.map((p) => (p.cpu / cpuLimit) * 100)),
      peakMem: Math.max(0, ...recent.map((p) => (p.mem / (p.memLimit || memLimit)) * 100)),
    };
  }, [metrics, live, cpuLimit, memLimit]);
  const empty = range === "live" ? (server.status === "running" ? "Collecting samples…" : "Not running") : EMPTY;
  const tFormat = (t: number) => (range === "live" ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : timeLabel(t, range));
  const first = cpu[0]?.t, last = cpu[cpu.length - 1]?.t;
  const mb = (pct: number) => fmtBytes((pct / 100) * memLimit);

  return (
    <div className="usage-charts">
      <div className="usage-chart">
        <div className="usage-chart__head">
          <strong>CPU</strong>
          <span className="small faint">{cpu.length ? `Peak ${Math.round(peakCpu)}% of ${cpuLimit / 100 === 1 ? "1 core" : `${cpuLimit / 100} cores`}` : ""}</span>
        </div>
        <Sparkline points={cpu} max={100} height={92} label="CPU history" empty={empty} format={(v) => `${Math.round(v)}%`} formatTime={tFormat} />
        {cpu.length > 1 ? <Axis from={first} to={last} range={range} /> : null}
      </div>
      <div className="usage-chart">
        <div className="usage-chart__head">
          <strong>Memory</strong>
          <span className="small faint">{mem.length ? `Peak ${mb(peakMem)} of ${fmtBytes(memLimit)}` : ""}</span>
        </div>
        <Sparkline points={mem} max={100} height={92} label="Memory history" empty={empty} format={(v) => `${mb(v)} (${Math.round(v)}%)`} formatTime={tFormat} />
        {mem.length > 1 ? <Axis from={first} to={last} range={range} /> : null}
      </div>
    </div>
  );
}

function Axis({ from, to, range }: { from?: number; to?: number; range: Range }) {
  if (!from || !to) return null;
  const mid = from + (to - from) / 2;
  return (
    <div className="usage-axis small faint" aria-hidden="true">
      <span>{axisLabel(from, range)}</span>
      <span>{axisLabel(mid, range)}</span>
      <span>{axisLabel(to, range)}</span>
    </div>
  );
}
