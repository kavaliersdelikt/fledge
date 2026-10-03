import type { Quota } from "./api";

/** The quota editor works in friendly units (GB, cores); the API stores MB and CPU percent. */
export type QuotaForm = { servers: string; memoryGb: string; cpuCores: string; diskGb: string; backups: string; extraPorts: string };

const trim = (n: number) => String(Math.round(n * 100) / 100);
const has = (n?: number | null): n is number => typeof n === "number" && Number.isFinite(n);

export function quotaToForm(q?: Quota | null): QuotaForm {
  return {
    servers: has(q?.maxServers) ? String(q!.maxServers) : "",
    memoryGb: has(q?.maxMemoryMb) ? trim(q!.maxMemoryMb! / 1024) : "",
    cpuCores: has(q?.maxCpuPercent) ? trim(q!.maxCpuPercent! / 100) : "",
    diskGb: has(q?.maxDiskMb) ? trim(q!.maxDiskMb! / 1024) : "",
    backups: has(q?.maxBackups) ? String(q!.maxBackups) : "",
    extraPorts: has(q?.maxExtraPorts) ? String(q!.maxExtraPorts) : "",
  };
}

function amount(value: string, label: string, scale: number, whole: boolean): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number, 0 or more. Leave it empty for no limit.`);
  if (whole && !Number.isInteger(n)) throw new Error(`${label} must be a whole number.`);
  return Math.round(n * scale);
}

/** Returns the body for PATCH /customers/:id, or null when nothing is limited. Throws a readable error for bad input. */
export function formToQuota(f: QuotaForm): Quota | null {
  const q: Quota = {};
  const set = <K extends keyof Quota>(k: K, v: number | undefined) => {
    if (v !== undefined) q[k] = v;
  };
  set("maxServers", amount(f.servers, "Servers", 1, true));
  set("maxMemoryMb", amount(f.memoryGb, "Memory", 1024, false));
  set("maxCpuPercent", amount(f.cpuCores, "CPU", 100, false));
  set("maxDiskMb", amount(f.diskGb, "Disk", 1024, false));
  set("maxBackups", amount(f.backups, "Backups", 1, true));
  set("maxExtraPorts", amount(f.extraPorts, "Extra ports", 1, true));
  return Object.keys(q).length ? q : null;
}

export function hasQuota(q?: Quota | null) {
  return !!q && Object.values(q).some(has);
}

/** Share of a limit in use, 0..100+, or null for an unlimited resource. */
export function quotaShare(used: number, limit?: number | null): number | null {
  if (!has(limit)) return null;
  if (limit <= 0) return used > 0 ? 100 : 0;
  return (used / limit) * 100;
}
