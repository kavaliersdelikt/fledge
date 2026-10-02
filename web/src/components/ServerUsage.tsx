"use client";
import type { Server } from "@/lib/api";
import { fmtBytes, fmtCpu, fmtMb } from "@/lib/format";
import { UsageBar } from "./charts";

const FRESH_MS = 90_000;

/** The node's latest sample for a running server, or null if there isn't a recent one. */
export function liveUsage(s: Server, now = Date.now()) {
  const u = s.usage;
  if (s.status !== "running" || !u?.sampledAt || typeof u.cpuPercent !== "number" || typeof u.memoryBytes !== "number") return null;
  if (now - Date.parse(u.sampledAt) > FRESH_MS) return null;
  return { cpu: u.cpuPercent, mem: u.memoryBytes, memLimit: u.memoryLimitBytes || s.memoryMb * 1024 * 1024 };
}

export function CpuCell({ server: s }: { server: Server }) {
  const live = liveUsage(s);
  return (
    <UsageBar
      used={live ? live.cpu : null}
      limit={s.cpuPercent}
      label={`${s.name} CPU`}
      text={live ? `${Math.round((live.cpu / Math.max(1, s.cpuPercent)) * 100)}%` : "—"}
      sub={fmtCpu(s.cpuPercent)}
    />
  );
}

export function MemoryCell({ server: s }: { server: Server }) {
  const live = liveUsage(s);
  return (
    <UsageBar
      used={live ? live.mem : null}
      limit={live ? live.memLimit : 1}
      label={`${s.name} memory`}
      text={live ? fmtBytes(live.mem) : "—"}
      sub={fmtMb(s.memoryMb)}
    />
  );
}
