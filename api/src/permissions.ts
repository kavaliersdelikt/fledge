// The administrator catalogue is also consumed by the panel and documentation generator.
export const PERMISSIONS = {
  Servers: [
    "servers.view",
    "servers.power",
    "servers.console",
    "servers.files",
    "servers.backups",
    "servers.manage",
  ],
  Virtualization: ["servers.vm.configure", "servers.vm.network", "servers.vm.media", "servers.vm.snapshots"],
  Nodes: ["nodes.view", "nodes.manage"],
  Customers: [
    "customers.view",
    "customers.edit",
    "customers.suspend",
    "customers.security",
    "customers.delete",
  ],
  Billing: ["billing.view", "billing.manage", "billing.refund"],
  Support: [
    "support.view",
    "support.reply",
    "support.assign",
    "support.manage",
    "support.articles",
    "support.reports",
    "support.delete",
  ],
  Platform: [
    "templates.manage",
    "plugins.manage",
    "settings.view",
    "settings.edit",
    "appearance.edit",
    "email.manage",
    "notifications.manage",
    "failover.manage",
    "updates.apply",
    "audit.view",
  ],
  Team: ["team.manage"],
} as const;
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS][number];
export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS).flat();
export const PRESETS: Record<string, Permission[]> = {
  "Super admin": ALL_PERMISSIONS,
  Administrator: ALL_PERMISSIONS.filter((p) => p !== "team.manage"),
  Operator: [
    ...PERMISSIONS.Servers,
    ...PERMISSIONS.Nodes,
    ...PERMISSIONS.Virtualization,
    "templates.manage",
    "plugins.manage",
    "failover.manage",
    "settings.view",
    "support.view",
    "support.reply",
  ],
  Support: [
    "servers.view",
    "servers.power",
    "servers.console",
    "customers.view",
    "customers.suspend",
    "billing.view",
    "audit.view",
    "support.view",
    "support.reply",
    "support.assign",
    "support.articles",
    "support.reports",
  ],
  Billing: ["customers.view", ...PERMISSIONS.Billing],
  "Read-only": ALL_PERMISSIONS.filter((p) => p.endsWith(".view")),
  Custom: [],
};
export function validPermissions(value: unknown): value is Permission[] {
  return (
    Array.isArray(value) &&
    value.length <= ALL_PERMISSIONS.length &&
    value.every((p) => ALL_PERMISSIONS.includes(p) && p !== "team.manage") &&
    new Set(value).size === value.length
  );
}
/** Central route policy. Unknown administrative paths have no grant: fail closed. */
export function routePermission(
  method: string,
  path: string,
  action?: string,
): Permission | null {
  const read = method === "GET" || method === "HEAD",
    p = path.split("?")[0];
  if (p.startsWith("/api/virtualization")) return read ? "nodes.view" : "nodes.manage";
  if (/^\/api\/servers\/[^/]+\/vm(?:\/|$)/.test(p)) {
    if (p.endsWith("console-ticket")) return "servers.console";
    if (p.endsWith("migrate") || p.endsWith("migration-targets")) return "servers.manage";
    if (read) return "servers.view";
    if (p.includes("/snapshots")) return "servers.vm.snapshots";
    if (p.endsWith("network")) return "servers.vm.network";
    if (p.endsWith("installation")) return "servers.vm.media";
    return "servers.vm.configure";
  }
  if (p.startsWith("/api/usage")) return "team.manage";
  if (p.startsWith("/api/team")) return "team.manage";
  if (p.startsWith("/api/customers")) {
    if (/\/(?:suspend|suspension)(?:\/reply)?$/.test(p))
      return read ? "customers.view" : "customers.suspend";
    if (/\/(?:sign-out|reset-password)$/.test(p)) return "customers.security";
    return read
      ? "customers.view"
      : method === "DELETE"
        ? "customers.delete"
        : "customers.edit";
  }
  if(p==="/api/cron/preview")return "servers.manage";
  if (p.startsWith("/api/servers")) {
    if (p.endsWith("/actions"))
      return action === "backup" || action === "restore"
        ? "servers.backups"
        : ["start", "stop", "restart", "kill"].includes(action || "")
          ? "servers.power"
          : "servers.manage";
    if (/\/(?:console|rcon|live)(?:\/|$)/.test(p)) return "servers.console";
    if (/\/(?:files|sftp)(?:\/|$)/.test(p)) return "servers.files";
    if (/\/(?:backups|verification)(?:\/|$)/.test(p)) return "servers.backups";
    return read ? "servers.view" : "servers.manage";
  }
  if (p.startsWith("/api/nodes")) return read ? "nodes.view" : "nodes.manage";
  if (p.startsWith("/api/support")) {
    if (p.endsWith("/suspension-settings")) return "customers.suspend";
    if (p.includes("/reports")) return "support.reports";
    if (p.includes("/articles") || p.endsWith("/search"))
      return read ? "support.view" : "support.articles";
    if (
      /\/(settings|tiers|hours|rules|macros|groups|categories)(?:\/|$)/.test(p)
    )
      return read ? "support.view" : "support.manage";
    if (
      p.endsWith("/messages") ||
      p.endsWith("/attachments") ||
      p.includes("/drafts/")
    )
      return "support.reply";
    if (p.endsWith("/suspension-settings")) return "customers.suspend";
    return read
      ? "support.view"
      : method === "DELETE"
        ? "support.delete"
        : "support.assign";
  }
  if (p.startsWith("/api/billing") || p.startsWith("/api/plans"))
    return p.includes("/refund")
      ? "billing.refund"
      : read
        ? "billing.view"
        : "billing.manage";
  if (p.startsWith("/api/templates")) return "templates.manage";
  if (p.startsWith("/api/plugins")) return "plugins.manage";
  if (p.startsWith("/api/branding"))
    return read ? "settings.view" : "appearance.edit";
  if (p.startsWith("/api/email") || p.startsWith("/api/settings/email"))
    return "email.manage";
  if (p.startsWith("/api/settings"))
    return read ? "settings.view" : "settings.edit";
  if (p.startsWith("/api/notification")) return "notifications.manage";
  if (p.startsWith("/api/failover")) return "failover.manage";
  if (
    p.startsWith("/api/updates") ||
    p.startsWith("/api/agent-updates") ||
    p.startsWith("/api/agent-releases")
  )
    return read ? "settings.view" : "updates.apply";
  if (
    p.startsWith("/api/audit") ||
    p.startsWith("/api/activity") ||
    p === "/api/openapi.json" ||
    p === "/api/metrics"
  )
    return "audit.view";
  if (p.startsWith("/api/signup") || p.startsWith("/api/limits/customers"))
    return read ? "customers.view" : "customers.edit";
  if (p === "/api/overview" || p === "/api/jobs") return "servers.view";
  if (p.startsWith("/api/tokens")) return "settings.edit";
  if (p === "/api/storage/status") return "servers.backups";
  return null;
}
