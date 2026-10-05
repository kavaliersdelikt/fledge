import {
  bootStack,
  client,
  bootstrapAdmin,
  makeNode,
  heartbeat,
  dbQuery,
  nextJob,
  finishJob,
} from "./harness.mjs";
const stack = await bootStack({
  db: "fledge_mews_smoke",
  apiPort: 4187,
  hostPort: 4537,
  mock: null,
});
const admin = client(stack.base),
  { call, ok, status, check } = admin;
try {
  await bootstrapAdmin(admin);
  check(
    ok(await call("GET", "/api/auth/me"), "me").isSuper,
    "bootstrap super admin",
  );
  const user = ok(
      await call("POST", "/api/customers", { email: "mews@example.test" }),
      "customer",
    ),
    customer = client(stack.base);
  customer.ok(
    await customer.call("POST", "/api/auth/login", {
      email: user.email,
      password: user.temporaryPassword,
    }),
    "login",
  );
  const node = await makeNode(admin, "Mews");
  await heartbeat(admin, node);
  const created = ok(
      await call("POST", "/api/servers", {
        ownerId: user.id,
        templateId: "minecraft-java",
        name: "Mews server",
        memoryMb: 1024,
        cpuPercent: 100,
        diskMb: 2048,
      }),
      "server",
    ),
    server = created.server || created;
  await finishJob(admin, node, await nextJob(admin, node));
  const s = ok(
    await call("POST", `/api/customers/${user.id}/suspend`, {
      reason: "billing",
      message: "Please settle the invoice.",
      internalNote: "private investigation",
    }),
    "suspend",
  );
  const stopJob = await nextJob(admin, node);
  check(stopJob.kind === "stop", "suspension uses ordinary stop job");
  await finishJob(admin, node, stopJob);
  const history = ok(
    await call("GET", `/api/customers/${user.id}/suspension`),
    "stop history",
  );
  check(
    history.events.some((e) => e.kind === "servers_stop_requested") &&
      history.events.some((e) => e.kind === "servers_stopped"),
    "stop history waits for node acknowledgement",
  );
  check(/^MWS-[A-F0-9]{8}-[A-F0-9]{2}$/.test(s.reference), "random reference");
  customer.ok(await customer.call("GET", "/api/auth/me"), "session works");
  customer.status(
    await customer.call("GET", `/api/servers/${server.id}`),
    403,
    "server blocked",
  );
  customer.status(
    await customer.call("POST", "/api/store/checkout", {}),
    403,
    "purchases blocked",
  );
  check(
    !JSON.stringify(
      customer.ok(await customer.call("GET", "/api/suspension"), "suspension"),
    ).includes("private investigation"),
    "note private",
  );
  const appeal = customer.ok(
    await customer.call("POST", "/api/suspension/appeal", {
      body: "Can you check my payment?",
    }),
    "appeal with desk disabled",
  );
  ok(
    await call("POST", `/api/support/tickets/${appeal.id}/messages`, {
      body: "Internal only",
      kind: "note",
    }),
    "note",
  );
  ok(
    await call("POST", `/api/support/tickets/${appeal.id}/messages`, {
      body: "We are checking.",
    }),
    "reply",
  );
  const thread = customer.ok(
    await customer.call("GET", `/api/support/tickets/${appeal.id}`),
    "thread",
  );
  check(
    thread.messages.length === 2 &&
      !JSON.stringify(thread).includes("Internal only"),
    "notes excluded",
  );
  customer.status(
    await customer.call("GET", "/api/support/tickets"),
    403,
    "general desk blocked",
  );
  ok(
    await call("PATCH", `/api/support/tickets/${appeal.id}`, {
      status: "closed",
    }),
    "close appeal",
  );
  customer.ok(
    await customer.call("POST", `/api/support/tickets/${appeal.id}/reopen`, {}),
    "reopen linked appeal while suspended",
  );
  customer.ok(
    await customer.call("POST", `/api/support/tickets/${appeal.id}/messages`, {
      body: "I have more information for my appeal.",
    }),
    "continued appeal",
  );
  ok(await call("DELETE", `/api/customers/${user.id}/suspension`), "lift");
  customer.ok(
    await customer.call("GET", `/api/servers/${server.id}`),
    "access returns",
  );
  customer.status(
    await customer.call("POST", "/api/support/tickets", {}),
    403,
    "desk off",
  );
  ok(await call("PUT", "/api/support/settings", { enabled: true }), "enable");
  const cfg = customer.ok(
      await customer.call("GET", "/api/support/config"),
      "config",
    ),
    ticket = customer.ok(
      await customer.call("POST", "/api/support/tickets", {
        categoryId: cfg.categories[0].id,
        subject: "Server question",
        body: "How do I install a mod?",
      }),
      "ticket",
    );
  ok(
    await call("POST", `/api/support/tickets/${ticket.id}/messages`, {
      body: "Use Add-ons.",
      status: "pending",
    }),
    "pending",
  );
  customer.ok(
    await customer.call("POST", `/api/support/tickets/${ticket.id}/messages`, {
      body: "Thanks.",
    }),
    "reply",
  );
  customer.ok(
    await customer.call("PATCH", `/api/support/tickets/${ticket.id}`, {
      status: "solved",
    }),
    "solve",
  );
  customer.ok(
    await customer.call("POST", `/api/support/tickets/${ticket.id}/rating`, {
      rating: 5,
    }),
    "rate",
  );
  customer.status(
    await customer.call("POST", `/api/support/tickets/${ticket.id}/rating`, {
      rating: 4,
    }),
    409,
    "once",
  );
  customer.ok(
    await customer.call("POST", `/api/support/tickets/${ticket.id}/reopen`, {}),
    "reopen",
  );
  const other = ok(
      await call("POST", "/api/customers", { email: "other@example.test" }),
      "other",
    ),
    outsider = client(stack.base);
  outsider.ok(
    await outsider.call("POST", "/api/auth/login", {
      email: other.email,
      password: other.temporaryPassword,
    }),
    "other login",
  );
  outsider.status(
    await outsider.call("GET", `/api/support/tickets/${ticket.id}`),
    404,
    "isolation",
  );
  outsider.status(
    await outsider.call("GET", "/api/team"),
    403,
    "team protected",
  );
  const db = (sql, args) => dbQuery(stack.databaseUrl, sql, args);
  check(!(await call("GET", "/api/support/inbound/settings")).data?.enabled, "inbound bridge starts disabled");
  status(await call("PUT", "/api/support/inbound/settings", { enabled: true }), 409, "bridge cannot enable without a secret");
  const bridge = ok(await call("POST", "/api/support/inbound/secret", {}), "generate bridge secret");
  check(bridge.secret.length >= 32, "generated bridge key has enough entropy");
  const storedBridge = (await db("SELECT value,secret FROM settings WHERE key='support_inbound'"))[0];
  check(storedBridge.value.enabled === false && !storedBridge.secret.includes(bridge.secret), "bridge secret is stored encrypted and stays disabled until enabled");
  ok(await call("PUT", "/api/support/inbound/settings", { enabled: true }), "enable bridge from panel");
  check((await call("GET", "/api/support/inbound/settings")).data.enabled, "panel reports enabled bridge state");
  ok(await call("PUT", "/api/support/inbound/settings", { enabled: false }), "disable bridge from panel");
  check(!(await call("GET", "/api/support/inbound/settings")).data.enabled, "panel disables inbound replies immediately");
  const listed = ok(await call("GET", "/api/support/tickets"), "queue");
  check(
    listed.find((t) => t.id === ticket.id).unread,
    "customer reply is unread for agent",
  );
  ok(await call("GET", `/api/support/tickets/${ticket.id}`), "mark read");
  check(
    !ok(await call("GET", "/api/support/tickets"), "read queue").find(
      (t) => t.id === ticket.id,
    ).unread,
    "opening ticket marks it read",
  );
  ok(
    await call("PATCH", `/api/support/tickets/${ticket.id}`, {
      priority: "urgent",
      linkedTicketIds: [appeal.id],
    }),
    "urgent link",
  );
  const urgent = ok(
    await call("GET", `/api/support/tickets/${ticket.id}`),
    "urgent",
  );
  check(
    urgent.tier_id === "urgent" && urgent.linkedTickets[0].id === appeal.id,
    "urgent goals and linked context",
  );
  const macro = ok(
    await call("POST", "/api/support/macros", {
      name: "Before",
      shortcut: "/before",
      body: "Original text",
    }),
    "macro",
  );
  ok(
    await call("POST", "/api/support/macros", {
      id: macro.id,
      name: "After",
      shortcut: "/after",
      body: "Updated text",
      scope: "personal",
    }),
    "edit macro",
  );
  check(
    ok(await call("GET", "/api/support/macros"), "macros").find(
      (m) => m.id === macro.id,
    ).body === "Updated text",
    "macro edit is in place",
  );
  const group = ok(
    await call("POST", "/api/support/groups", {
      name: "New group",
      members: [],
    }),
    "group",
  );
  ok(
    await call("PUT", `/api/support/groups/${group.id}`, {
      name: "Edited group",
      members: [],
    }),
    "edit group",
  );
  const rule = ok(
    await call("POST", "/api/support/rules", {
      name: "Before rule",
      trigger: "created",
      conditions: {},
      actions: [{ kind: "tag", value: "before" }],
    }),
    "rule",
  );
  ok(
    await call("POST", "/api/support/rules", {
      id: rule.id,
      name: "After rule",
      trigger: "status_changed",
      conditions: { priority: "urgent" },
      actions: [{ kind: "tag", value: "after" }],
      enabled: true,
      position: 7,
    }),
    "edit rule",
  );
  ok(
    await call("PATCH", `/api/support/tickets/${ticket.id}`, {
      status: "pending",
    }),
    "status trigger",
  );
  const ruled = ok(
    await call("GET", `/api/support/tickets/${ticket.id}`),
    "rule run",
  );
  check(
    ruled.tags.includes("after") &&
      ruled.events.some(
        (e) => e.kind === "rule" && e.data.name === "After rule",
      ),
    "edited status rule executes and logs",
  );
  await db(
    "UPDATE support_tickets SET status='solved',created_at=now()-interval '2 days',solved_at=now() WHERE id=$1",
    [ticket.id],
  );
  customer.status(
    await customer.call("PATCH", `/api/support/tickets/${ticket.id}`, {
      status: "solved",
    }),
    403,
    "customer cannot reset a solved ticket's reopen window",
  );
  const report = ok(await call("GET", "/api/support/reports"), "report");
  check(
    report.daily.length === 30 && report.daily.at(-1).solved >= 1,
    "report counts resolution on actual day, with thirty daily rows",
  );
  await db(
    "INSERT INTO support_tickets(requester_email,subject,source) SELECT 'pagination@example.test','Queue page '||n,'panel' FROM generate_series(1,101) n",
  );
  check(
    ok(
      await call("GET", "/api/support/tickets?offset=100"),
      "queue second page",
    ).length > 0,
    "queue pagination reaches older tickets",
  );
  const superSecret = (
    await db("SELECT totp_secret FROM users WHERE is_super")
  )[0].totp_secret;
  await db(
    "UPDATE users SET role='admin',admin_permissions=ARRAY['servers.view'],totp_secret=$2 WHERE id=$1",
    [other.id, superSecret],
  );
  const restrictedInbox = outsider.ok(
    await outsider.call("GET", "/api/notifications"),
    "restricted own inbox",
  );
  check(
    !restrictedInbox.items.some(
      (n) => n.kind.startsWith("support.") || n.kind.startsWith("suspension."),
    ),
    "delegated inbox does not leak ticket events without grant",
  );
  console.log("Mews smoke passed");
} finally {
  await stack.stop();
}
