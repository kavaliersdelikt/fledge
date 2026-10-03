const TB = 1000 * 1024; // in MB; 1,000 GB reads better as 1 TB

/** Megabytes to a short human value: 512 MB, 6 GB, 1.5 TB. */
export function fmtMb(mb?: number | null) {
  if (mb == null || !Number.isFinite(mb)) return "—";
  if (mb >= TB) return `${trim(mb / 1024 / 1024)} TB`;
  if (mb >= 1024) return `${trim(mb / 1024)} GB`;
  return `${Math.round(mb)} MB`;
}

/** "28 / 128 GB" — both values in the unit of the total. */
export function fmtMbPair(used: number, total: number) {
  const [div, unit] = total >= TB ? [1024 * 1024, "TB"] : total >= 1024 ? [1024, "GB"] : [1, "MB"];
  // A small share keeps its own unit ("115 GB / 1 TB", not "0.1 / 1 TB").
  if (used > 0 && used / div < 1) return `${fmtMb(used)} / ${fmtMb(total)}`;
  return `${trim(used / div)} / ${trim(total / div)} ${unit}`;
}

/** "11.5 / 32 cores" from CPU percentages (100% = one core). */
export function fmtCpuPair(used: number, total: number) {
  return `${trim(used / 100)} / ${trim(total / 100)} ${total === 100 ? "core" : "cores"}`;
}

/** Absolute short date: "2 Oct" this year, "2 Oct 2025" otherwise. */
export function fmtDay(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export function fmtClock(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—";
}

/** Bytes to a short human value. Accepts numeric strings (Postgres bigint). */
export function fmtBytes(value?: number | string | null) {
  const n = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1024 ** 3) return `${trim(n / 1024 ** 3)} GB`;
  if (n >= 1024 ** 2) return `${trim(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${trim(n / 1024)} KB`;
  return `${n} B`;
}

/** CPU budget where 100% is one core. */
export function fmtCpu(percent?: number | null) {
  if (percent == null) return "—";
  const cores = percent / 100;
  return `${trim(cores)} ${cores === 1 ? "core" : "cores"}`;
}

function trim(n: number) {
  if (n === 0) return "0";
  return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1).replace(/\.0$/, "");
}

export function fmtAgo(value?: string | null, now = Date.now()) {
  if (!value) return "—";
  const seconds = Math.round((now - Date.parse(value)) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 0) return fmtIn(-seconds);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 86400 * 7) return `${Math.round(seconds / 86400)} d ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtIn(seconds: number) {
  if (seconds < 60) return "in under a minute";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)} h`;
  return `in ${Math.round(seconds / 86400)} d`;
}

export function fmtTime(value?: string | null) {
  return value
    ? new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

const actions: Record<string, string> = {
  "2fa.enable": "Enabled two-factor authentication",
  "account.recover": "Recovered account",
  "backup.create": "Created backup",
  "backup.delete": "Deleted backup",
  "backup.retention.update": "Changed backup retention",
  bootstrap: "Created the panel",
  "collaborator.delete": "Removed collaborator",
  "collaborator.upsert": "Granted server access",
  "customer.create": "Created customer",
  "customer.update": "Updated customer",
  login: "Signed in",
  "node.create": "Registered node",
  "node.delete": "Removed node",
  "node.enrollment.rotate": "Issued node token",
  "node.update": "Updated node",
  "recovery_codes.rotate": "Generated recovery codes",
  "restore.request": "Requested restore",
  "server.create": "Created server",
  "server.delete.request": "Requested server deletion",
  "server.settings.update": "Changed startup variables",
  "server.update": "Updated server",
  "server.start": "Started server",
  "server.stop": "Stopped server",
  "server.restart": "Restarted server",
  "server.kill": "Force-stopped server",
  "server.suspend": "Suspended server",
  "server.unsuspend": "Unsuspended server",
  "server.reinstall": "Reinstalled server",
  "server.restore": "Restored server",
  "sftp.issue": "Issued SFTP credentials",
  "template.create": "Saved template",
  "token.create": "Created API token",
  "token.delete": "Revoked API token",
};

/** Readable sentence for an audit action; falls back to the raw key. */
export function fmtAction(action?: string) {
  if (!action) return "—";
  if (actions[action]) return actions[action];
  const [subject, ...verb] = action.split(".");
  return verb.length ? `${subject[0].toUpperCase()}${subject.slice(1)} ${verb.join(" ")}` : action;
}

export function shortId(id?: string | null) {
  return id ? id.slice(0, 8) : "—";
}

/** 1234 -> "1.2K", 3_400_000 -> "3.4M". */
export function fmtCompact(n?: number | null) {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
