import {
  bootStack,
  client,
  bootstrapAdmin,
  makeNode,
  heartbeat,
  dbQuery,
} from "./harness.mjs";
import { authenticator } from "otplib";
const stack = await bootStack({
  db: "fledge_mews_security",
  apiPort: 4188,
  hostPort: 4538,
  mock: null,
});
const admin = client(stack.base),
  { call, ok, status, check } = admin;
const db = (s, p) => dbQuery(stack.databaseUrl, s, p);
try {
  const credentials = await bootstrapAdmin(admin),
    superUser = ok(await call("GET", "/api/auth/me"), "me");
  const invited = ok(
    await call("POST", "/api/team", {
      email: "readonly@example.test",
      preset: "Read-only",
      totp: authenticator.generate(credentials.secret),
    }),
    "invite read-only",
  );
  check(!!invited.link, "single-use invitation provided without SMTP");
  const token = new URL(invited.link).searchParams.get("token"),
    reader = client(stack.base);
  reader.ok(
    await reader.call("POST", "/api/auth/token/accept", {
      token,
      password: "a-long-read-only-password",
    }),
    "accept",
  );
  reader.ok(
    await reader.call("POST", "/api/auth/login", {
      email: invited.email,
      password: "a-long-read-only-password",
    }),
    "login",
  );
  reader.status(
    await reader.call("GET", "/api/servers"),
    403,
    "MFA setup required",
  );
  const setup = reader.ok(
    await reader.call("POST", "/api/auth/2fa/setup", {}),
    "setup",
  );
  reader.ok(
    await reader.call("POST", "/api/auth/2fa/confirm", {
      code: authenticator.generate(setup.secret),
    }),
    "confirm",
  );
  reader.ok(await reader.call("GET", "/api/servers"), "read");
  reader.status(
    await reader.call("POST", "/api/nodes", {}),
    403,
    "mutations denied",
  );
  reader.status(await reader.call("GET", "/api/team"), 403, "team exclusive");
  reader.status(
    await reader.call("GET", "/api/settings"),
    200,
    "read settings",
  );
  reader.status(
    await reader.call("PUT", "/api/settings/security", {}),
    403,
    "security denied",
  );
  ok(
    await call("PUT", `/api/team/${invited.id}/permissions`, {
      permissions: ["servers.view"],
    }),
    "change grants",
  );
  reader.status(
    await reader.call("GET", "/api/settings"),
    403,
    "live session reflects revocation",
  );
  status(
    await call("PUT", `/api/team/${invited.id}/permissions`, {
      permissions: ["team.manage"],
    }),
    400,
    "no delegation",
  );
  status(
    await call("PUT", `/api/team/${superUser.id}/permissions`, {
      permissions: [],
    }),
    403,
    "no self edit",
  );
  status(
    await call("DELETE", `/api/team/${superUser.id}`),
    403,
    "super cannot be removed",
  );
  const operatorInvite = ok(
      await call("POST", "/api/team", {
        email: "operator@example.test",
        preset: "Operator",
        totp: authenticator.generate(credentials.secret),
      }),
      "invite operator",
    ),
    operator = client(stack.base);
  operator.ok(
    await operator.call("POST", "/api/auth/token/accept", {
      token: new URL(operatorInvite.link).searchParams.get("token"),
      password: "a-long-operator-password",
    }),
    "accept operator invitation",
  );
  operator.ok(
    await operator.call("POST", "/api/auth/login", {
      email: operatorInvite.email,
      password: "a-long-operator-password",
    }),
    "operator login",
  );
  const operatorSetup = operator.ok(
    await operator.call("POST", "/api/auth/2fa/setup", {}),
    "operator 2FA setup",
  );
  operator.ok(
    await operator.call("POST", "/api/auth/2fa/confirm", {
      code: authenticator.generate(operatorSetup.secret),
    }),
    "operator 2FA confirm",
  );
  const customer = ok(
      await call("POST", "/api/customers", { email: "holds@example.test" }),
      "customer",
    ),
    node = await makeNode(admin, "Hold matrix");
  await heartbeat(admin, node);
  const make = async (name) => {
    const r = ok(
      await call("POST", "/api/servers", {
        ownerId: customer.id,
        templateId: "minecraft-java",
        name,
        memoryMb: 512,
        cpuPercent: 50,
        diskMb: 1024,
      }),
      "server",
    );
    return r.server || r;
  };
  const normal = await make("Normal"),
    manual = await make("Admin hold"),
    billing = await make("Billing hold");
  operator.ok(await operator.call("GET", "/api/overview"), "operator overview data");
  operator.ok(await operator.call("GET", "/api/servers?limit=100&offset=0"), "operator overview servers");
  operator.ok(await operator.call("GET", "/api/jobs?limit=100"), "operator overview jobs");
  const operationalFeed = operator.ok(
    await operator.call("GET", "/api/activity/overview"),
    "operator overview activity",
  );
  check(operationalFeed.some((event) => event.action === "node.create"), "operator sees node activity");
  check(
    !operationalFeed.some((event) => event.action.startsWith("customer.")) &&
      operationalFeed.every((event) => !("detail" in event) && !("actor_email" in event)),
    "overview activity omits customer events and audit details",
  );
  operator.status(await operator.call("GET", "/api/activity"), 403, "operator cannot inspect full audit");
  await db(
    "UPDATE servers SET desired_status='running',observed_status='running' WHERE owner_id=$1",
    [customer.id],
  );
  await db(
    "UPDATE servers SET suspended=true,suspended_reason='admin',desired_status='stopped' WHERE id=$1",
    [manual.id],
  );
  await db(
    "UPDATE servers SET suspended=true,suspended_reason='billing',desired_status='stopped' WHERE id=$1",
    [billing.id],
  );
  ok(
    await call("POST", `/api/customers/${customer.id}/suspend`, {
      reason: "review",
      message: "A review is underway.",
    }),
    "suspend",
  );
  const rows = await db(
    "SELECT id,suspended,suspended_reason FROM servers WHERE owner_id=$1",
    [customer.id],
  );
  check(
    rows.every((s) => s.suspended),
    "all held",
  );
  check(
    rows.find((s) => s.id === manual.id).suspended_reason === "admin",
    "admin reason retained",
  );
  check(
    rows.find((s) => s.id === billing.id).suspended_reason === "billing",
    "billing reason retained",
  );
  status(
    await call("POST", `/api/servers/${manual.id}/actions`, {
      action: "unsuspend",
    }),
    409,
    "owner hold blocks manual start",
  );
  ok(await call("DELETE", `/api/customers/${customer.id}/suspension`), "lift");
  const restored = await db(
    "SELECT id,suspended,desired_status,suspended_reason FROM servers WHERE owner_id=$1",
    [customer.id],
  );
  check(
    !restored.find((s) => s.id === normal.id).suspended &&
      restored.find((s) => s.id === normal.id).desired_status === "running",
    "running account server restored",
  );
  check(
    restored.find((s) => s.id === manual.id).suspended &&
      restored.find((s) => s.id === billing.id).suspended,
    "independent holds retained",
  );
  ok(
    await call("PUT", "/api/support/settings", { enabled: true }),
    "enable desk",
  );
  const c = client(stack.base);
  c.ok(
    await c.call("POST", "/api/auth/login", {
      email: customer.email,
      password: customer.temporaryPassword,
    }),
    "login",
  );
  const config = c.ok(await c.call("GET", "/api/support/config"), "config"),
    t = c.ok(
      await c.call("POST", "/api/support/tickets", {
        categoryId: config.categories[0].id,
        subject: "Attachment question",
        body: "Please check my log.",
      }),
      "ticket",
    );
  const upload = async (name, text) => {
    const form = new FormData();
    form.append("file", new Blob([text], { type: "text/plain" }), name);
    const r = await fetch(
      stack.base + `/api/support/tickets/${t.id}/attachments`,
      { method: "POST", headers: { cookie: c.cookie }, body: form },
    );
    return { code: r.status, data: await r.json() };
  };
  c.status(
    await upload("unsafe.txt", "<svg></svg>"),
    400,
    "active document blocked",
  );
  const a = c.ok(
    await upload("server.log", "Server stopped normally."),
    "upload",
  );
  c.ok(
    await c.call("POST", `/api/support/tickets/${t.id}/messages`, {
      body: "Here is the log.",
      attachments: [a.id],
    }),
    "link attachment",
  );
  const response = await fetch(
    stack.base + `/api/support/tickets/${t.id}/attachments/${a.id}`,
    { headers: { cookie: c.cookie } },
  );
  check(
    response.ok &&
      response.headers.get("x-content-type-options") === "nosniff" &&
      response.headers.get("content-disposition").startsWith("attachment"),
    "safe download headers",
  );
  ok(
    await call("POST", "/api/support/rules", {
      name: "Log route",
      trigger: "customer_replied",
      conditions: { textContains: "log" },
      actions: [
        { kind: "tag", value: "logs" },
        { kind: "note", value: "Automation inspected the log request." },
      ],
    }),
    "rule",
  );
  c.ok(
    await c.call("POST", `/api/support/tickets/${t.id}/messages`, {
      body: "A second log.",
    }),
    "run rule",
  );
  const publicThread = c.ok(
    await c.call("GET", `/api/support/tickets/${t.id}`),
    "customer view",
  );
  check(
    !JSON.stringify(publicThread).includes("Automation inspected"),
    "rule notes private",
  );
  const desk = ok(
    await call("GET", `/api/support/tickets/${t.id}`),
    "agent view",
  );
  check(
    desk.tags.includes("logs") && desk.events.some((e) => e.kind === "rule"),
    "rule applied and logged",
  );
  ok(await call("DELETE", `/api/team/${invited.id}`), "remove");
  reader.status(
    await reader.call("GET", "/api/auth/me"),
    401,
    "sessions revoked",
  );
  console.log("Mews security smoke passed");
} finally {
  await stack.stop();
}
