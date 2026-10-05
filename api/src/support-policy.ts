import { pool, fail, hash } from "./core.js";
export type SupportSettings = {
  enabled: boolean;
  publicHelp: boolean;
  abuseEnabled: boolean;
  collaboratorTickets: boolean;
  ticketsPerDay: number;
  reopenDays: number;
  retentionDays: number;
  pendingNudgeDays: number;
  pendingCloseDays: number;
};
export const defaultSupport: SupportSettings = {
  enabled: false,
  publicHelp: false,
  abuseEnabled: false,
  collaboratorTickets: false,
  ticketsPerDay: 5,
  reopenDays: 14,
  retentionDays: 730,
  pendingNudgeDays: 3,
  pendingCloseDays: 7,
};
export async function supportSettings(): Promise<SupportSettings> {
  const r = (await pool.query("SELECT value FROM settings WHERE key='support'"))
    .rows[0];
  return { ...defaultSupport, ...r?.value };
}
export function validateSupport(input: any) {
  const out = { ...defaultSupport };
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in out)) fail(400, "Unknown support setting");
    if (typeof (out as any)[k] === "boolean") {
      if (typeof v !== "boolean") fail(400, k + " must be boolean");
    } else if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > 3650)
      fail(400, k + " must be an integer between 1 and 3650");
    (out as any)[k] = v;
  }
  return out;
}
export async function supportRate(key: string, max: number, seconds: number) {
  const r = (
    await pool.query(
      "INSERT INTO request_limits(bucket_hash,attempts,expires_at) VALUES($1,1,now()+make_interval(secs=>$2)) ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN request_limits.expires_at<=now() THEN 1 ELSE request_limits.attempts+1 END,expires_at=CASE WHEN request_limits.expires_at<=now() THEN EXCLUDED.expires_at ELSE request_limits.expires_at END RETURNING attempts",
      [hash("support:" + key), seconds],
    )
  ).rows[0];
  if (r.attempts > max)
    fail(429, "Support rate limit reached. Please try again later.");
}
export function customerTicket(t: any) {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    categoryId: t.category_id,
    category: t.category_name,
    serverId: t.server_id,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    firstReplyAt: t.first_reply_at,
    solvedAt: t.solved_at,
    reopenUntil: t.reopen_until,
    rating: t.rating,
    ratingComment: t.rating_comment,
  };
}
export function customerMessage(m: any) {
  return {
    id: m.id,
    authorKind: m.author_kind,
    authorName: m.author_kind === "customer" ? "You" : "Support",
    body: m.body,
    createdAt: m.created_at,
    via: m.via,
  };
}
export function detectAttachment(bytes: Buffer, name: string): string | null {
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) return null;
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])))
    return "application/zip";
  if (!/\.(txt|log|json)$/i.test(name) || bytes.includes(0)) return null;
  const text = bytes.toString("utf8");
  if (
    text.includes("\ufffd") ||
    /<\s*(?:!doctype|html|svg|script|iframe)\b/i.test(text)
  )
    return null;
  if (/\.json$/i.test(name)) {
    try {
      JSON.parse(text);
    } catch {
      return null;
    }
    return "application/json";
  }
  return "text/plain";
}
export function redactDiagnostics(value: any) {
  // Only approved metadata is collected; variables, credentials and addresses are absent by construction.
  return {
    name: value.name,
    status: value.observed_status,
    desiredStatus: value.desired_status,
    memoryMb: value.memory_mb,
    cpuPercent: value.cpu_percent,
    diskMb: value.disk_mb,
    template: value.template_id,
    usage: {
      memoryMb: value.usage?.memoryMb,
      cpuPercent: value.usage?.cpuPercent,
      diskMb: value.usage?.diskMb,
    },
    crash: { exitCode: value.crash_state?.exitCode },
  };
}

/** Shared text redaction for console diagnostics: replace known values before masking credential-shaped text. */
export function redactConsole(
  line: string,
  variables: Record<string, unknown> = {},
) {
  let out = String(line).slice(0, 8192);
  for (const [key, value] of Object.entries(variables))
    if (
      /secret|token|pass(?:word)?|credential|api.?key|private/i.test(key) &&
      typeof value === "string" &&
      value.length >= 3
    )
      out = out.split(value).join("[redacted]");
  return out
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
}
