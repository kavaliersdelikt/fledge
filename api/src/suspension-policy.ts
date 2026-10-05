const id = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const rules: [string, RegExp][] = [
  [
    "GET",
    /^\/api\/(?:auth\/me|features|suspension|servers|limits\/me|billing|notifications|notifications\/summary)$/,
  ],
  [
    "POST",
    /^\/api\/(?:auth\/logout|auth\/password|auth\/2fa\/(?:setup|confirm)|auth\/recovery-codes|auth\/sessions\/revoke-others|account\/email|suspension\/appeal|billing\/portal|notifications\/read)$/,
  ],
  ["PUT", /^\/api\/auth\/preferences$/],
  ["GET", /^\/api\/(?:auth\/(?:sessions|passkeys)|account\/export)$/],
  ["DELETE", new RegExp(`^/api/auth/(?:sessions|passkeys)/${id}$`, "i")],
  ["POST", /^\/api\/auth\/passkeys\/(?:options|verify)$/],
  [
    "POST",
    new RegExp(`^/api/billing/subscriptions/${id}/(?:cancel|resume)$`, "i"),
  ],
];
export function suspensionAllows(
  method: string,
  path: string,
  options: {
    allowDeletion?: boolean;
    allowBackupDownload?: boolean;
    ticketId?: string | null;
  } = {},
) {
  if (
    path.includes("%") ||
    path.includes("\\") ||
    path.includes("..") ||
    path.includes("//")
  )
    return false;
  if (rules.some(([m, re]) => m === method && re.test(path))) return true;
  if (
    options.allowDeletion &&
    method === "POST" &&
    /^\/api\/account\/delete(?:\/cancel)?$/.test(path)
  )
    return true;
  if (
    options.allowBackupDownload &&
    method === "GET" &&
    new RegExp(`^/api/servers/${id}/backups(?:/${id}/download)?$`, "i").test(
      path,
    )
  )
    return true;
  return (
    !!options.ticketId &&
    ((method === "GET" &&
      path === `/api/support/tickets/${options.ticketId}`) ||
      (method === "POST" &&
        (path === `/api/support/tickets/${options.ticketId}/messages` ||
          path === `/api/support/tickets/${options.ticketId}/reopen`)))
  );
}
