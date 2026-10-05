// Reuses the documentation demo stack; all accounts and traffic are fictional.
import {
  client,
  makeNode,
  heartbeat,
  dbQuery,
  nextJob,
  finishJob,
} from "../../api/test/harness.mjs";
import { createRequire } from "node:module";
const { authenticator } = createRequire(
  new URL("../../api/package.json", import.meta.url),
)("otplib");
export async function seedMews(demo) {
  const { c, stack } = demo,
    ok = c.ok,
    password = "mews-demo-password-2026";
  ok(
    await c.call("POST", "/api/auth/bootstrap", {
      email: "maya@fledge.demo",
      password,
    }),
    "bootstrap",
  );
  const setup = ok(await c.call("POST", "/api/auth/2fa/setup", {}), "setup");
  ok(
    await c.call("POST", "/api/auth/2fa/confirm", {
      code: authenticator.generate(setup.secret),
    }),
    "2fa",
  );
  const node = await makeNode(c, "frankfurt-01", "Frankfurt", {
    memoryMb: 32768,
    cpuPercent: 1600,
    diskMb: 262144,
  });
  await heartbeat(c, node);
  const ticker = setInterval(() => heartbeat(c, node).catch(() => {}), 5000);
  ticker.unref();
  const customer = ok(
      await c.call("POST", "/api/customers", {
        email: "alex@fledge.demo",
        password,
      }),
      "customer",
    ),
    suspended = ok(
      await c.call("POST", "/api/customers", {
        email: "dana@fledge.demo",
        password,
      }),
      "suspended customer",
    );
  const owner = client(stack.base),
    paused = client(stack.base);
  owner.ok(
    await owner.call("POST", "/api/auth/login", {
      email: customer.email,
      password,
    }),
    "customer login",
  );
  paused.ok(
    await paused.call("POST", "/api/auth/login", {
      email: suspended.email,
      password,
    }),
    "paused login",
  );
  const servers = [];
  for (const [user, name] of [
    [customer, "Survival SMP"],
    [suspended, "Creative world"],
    [suspended, "Community SMP"],
  ]) {
    const made = ok(
      await c.call("POST", "/api/servers", {
        ownerId: user.id,
        templateId: "minecraft-java",
        name,
        memoryMb: 2048,
        cpuPercent: 100,
        diskMb: 10240,
      }),
      "server",
    );
    servers.push(made.server || made);
  }
  await dbQuery(
    stack.databaseUrl,
    "UPDATE servers SET observed_status='running',desired_status='running'; UPDATE jobs SET state='succeeded',finished_at=now() WHERE kind='create'",
  );
  ok(
    await c.call("PUT", "/api/support/settings", {
      enabled: true,
      publicHelp: true,
      abuseEnabled: true,
    }),
    "enable desk",
  );
  ok(
    await c.call("POST", "/api/support/articles", {
      slug: "server-wont-start",
      title: "When your Minecraft server won’t start",
      category: "Servers",
      visibility: "public",
      body: "Start with the console. The last few lines usually explain what stopped the server.\n\n## Out of memory\n\nIf the process exits with code 137, check your memory usage. Reduce the view distance or remove unused mods before increasing the memory limit.\n\n## Plugin or mod errors\n\nCheck that your plugins match the server software and version. Keep a backup before changing them.\n\nIf you are still stuck, open a ticket with the server selected and include its diagnostics.",
    }),
    "article",
  );
  ok(
    await c.call("POST", "/api/support/articles", {
      slug: "find-invoice",
      title: "Find and pay an invoice",
      category: "Billing",
      visibility: "customers",
      body: "Open Billing from your account. Your invoices list the amount, payment state and the provider’s payment link.\n\nPay open invoices through the secure provider page. Your host never needs your card details in a ticket.",
    }),
    "article",
  );
  ok(
    await c.call("POST", "/api/support/macros", {
      name: "Memory check",
      shortcut: "/memory",
      body: "Hi {{customer}}, the server may be reaching its memory limit. Please check the console for exit code 137 and reduce the view distance.",
    }),
    "macro",
  );
  const cfg = owner.ok(
    await owner.call("GET", "/api/support/config"),
    "config",
  );
  const tickets = [];
  for (const [subject, body] of [
    [
      "Server stops after players join",
      "Our server stops when the fourth player joins. Could you look at the memory limit?",
    ],
    ["Moving our world", "Can we move our world to another location?"],
    ["Finding an invoice", "Where can I download last month’s invoice?"],
  ]) {
    tickets.push(
      owner.ok(
        await owner.call("POST", "/api/support/tickets", {
          subject,
          body,
          categoryId: cfg.categories[0].id,
          serverId: servers[0].id,
          includeDiagnostics: true,
        }),
        "ticket",
      ),
    );
  }
  ok(
    await c.call("POST", `/api/support/tickets/${tickets[0].id}/messages`, {
      kind: "note",
      body: "Internal: check the last restart and the current memory allocation.",
    }),
    "note",
  );
  ok(
    await c.call("POST", `/api/support/tickets/${tickets[0].id}/messages`, {
      body: "Thanks for the details. Please check whether the console reports exit code 137. I’m reviewing the memory allocation.",
      status: "pending",
    }),
    "reply",
  );
  ok(
    await c.call("PATCH", `/api/support/tickets/${tickets[2].id}`, {
      status: "solved",
    }),
    "solve",
  );
  owner.ok(
    await owner.call("POST", `/api/support/tickets/${tickets[2].id}/rating`, {
      rating: 5,
    }),
    "rating",
  );
  ok(
    await c.call("POST", `/api/customers/${suspended.id}/suspend`, {
      reason: "billing",
      message:
        "Your latest invoice is overdue. Please open Billing and settle the outstanding balance. Your worlds are kept safe while we sort this out.",
      internalNote: "Customer requested a short extension.",
      until: new Date(Date.now() + 48 * 3600000).toISOString(),
    }),
    "suspend",
  );
  // A documentation-only node completes the normal stop jobs; no running server is depicted as stopped.
  for (let job; (job = await nextJob(c, node));) await finishJob(c, node, job);
  const signup = ok(await c.call("GET", "/api/settings"), "settings").signup;
  // Official Cloudflare test keys, only in this disposable demo: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
  ok(
    await c.call("PUT", "/api/settings/signup", {
      ...signup,
      captchaProvider: "turnstile",
      captchaSiteKey: "1x00000000000000000000AA",
      captchaSecret: "1x0000000000000000000000000000000AA",
    }),
    "demo bot protection",
  );
  const appeal = paused.ok(
    await paused.call("POST", "/api/suspension/appeal", {
      body: "I have updated my payment method. Could you check the invoice again?",
    }),
    "appeal",
  );
  ok(
    await c.call("POST", `/api/support/tickets/${appeal.id}/messages`, {
      body: "Thanks, Dana. We’re checking the payment and will update you here.",
    }),
    "appeal reply",
  );
  ok(
    await c.call("POST", "/api/team", {
      email: "jonas@fledge.demo",
      preset: "Support",
    }),
    "team",
  );
  await dbQuery(
    stack.databaseUrl,
    "UPDATE support_tickets SET created_at=now()-interval '1 hour',updated_at=now()-interval '15 minutes'",
  );
  return {
    customer,
    suspended,
    owner,
    paused,
    tickets,
    appeal,
    servers,
    totpSecret: setup.secret,
    stop: () => clearInterval(ticker),
  };
}
