import {
  supportInbound,
  inboundEnabled,
  replyToken,
} from "./support-inbound.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import {
  pool,
  can,
  fail,
  txt,
  asId,
  audit,
  hash,
  encrypt,
  WEB_ORIGIN,
  looksLikeEmail,
} from "./core.js";
import {
  supportSettings,
  validateSupport,
  supportRate,
  customerTicket,
  customerMessage,
  detectAttachment,
  redactDiagnostics,
  redactConsole,
} from "./support-policy.js";
import {
  addBusinessMinutes,
  validateHours,
  businessMinutesBetween,
  type BusinessHours,
} from "./support-clock.js";
import { sendTemplate } from "./email.js";
import { emit, notifyUser } from "./notifications.js";
import { suspensionSettings } from "./suspension.js";
import { resolveLimits } from "./limits.js";
import { settings } from "./settings.js";
import { verifyCaptcha } from "./signup.js";
const isAgent = (req: FastifyRequest) => req.actor?.role === "admin";
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const ticketSelect =
  "SELECT t.*,c.name AS category_name,u.email AS customer_email FROM support_tickets t LEFT JOIN support_categories c ON c.id=t.category_id LEFT JOIN users u ON u.id=t.requester_user_id";
async function deskEnabled(req: FastifyRequest) {
  if (!(await supportSettings()).enabled && !req.actor?.suspended)
    fail(403, "The help desk is disabled");
}
async function access(req: FastifyRequest, id: string) {
  const t = (await q(ticketSelect + " WHERE t.id=$1", [asId(id)]))[0];
  if (!t) fail(404, "Ticket not found");
  if (isAgent(req)) {
    can(req, "support.view");
    return t;
  }
  if (t.requester_user_id !== req.actor!.id) {
    const cfg = await supportSettings();
    if (
      !cfg.collaboratorTickets ||
      t.source === "abuse_form" ||
      !t.server_id ||
      !(
        await q(
          "SELECT 1 FROM collaborators WHERE server_id=$1 AND user_id=$2 AND 'manage'=ANY(permissions)",
          [t.server_id, req.actor!.id],
        )
      ).length
    )
      fail(404, "Ticket not found");
  }
  if (
    req.actor!.suspended &&
    (!t.suspension_id ||
      !(
        await q(
          "SELECT 1 FROM account_suspensions WHERE id=$1 AND user_id=$2 AND lifted_at IS NULL",
          [t.suspension_id, req.actor!.id],
        )
      ).length)
  )
    fail(403, "Only your suspension appeal is available");
  if (!t.suspension_id) await deskEnabled(req);
  return t;
}
async function hours(): Promise<BusinessHours> {
  return (
    await q("SELECT timezone,weekly,holidays FROM support_hours WHERE id=1")
  )[0];
}
async function event(
  id: string,
  kind: string,
  actor: string | null,
  data: any = {},
) {
  await pool.query(
    "INSERT INTO support_events(ticket_id,kind,actor,data) VALUES($1,$2,$3,$4)",
    [id, kind, actor, JSON.stringify(data)],
  );
}
async function mail(t: any, template: string, message: string) {
  return sendTemplate(
    template,
    t.requester_email,
    {
      reference: "#" + t.number,
      message:
        message +
        ((await inboundEnabled())
          ? `\n\nEmail reply reference: ${t.id}.${await replyToken(t.id, t.requester_email)}`
          : ""),
      link: `${WEB_ORIGIN}/support/${t.id}`,
    },
    { userId: t.requester_user_id },
  );
}
async function diagnostics(req: FastifyRequest, id: string) {
  const s = (
    await q(
      "SELECT * FROM servers WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
      [asId(id), req.actor!.id],
    )
  )[0];
  if (!s) fail(404, "Your server was not found");
  const logs = (
    await q(
      "SELECT frame->>'data' AS line FROM console_events WHERE server_id=$1 AND frame->>'type'='log' ORDER BY id DESC LIMIT 100",
      [s.id],
    )
  )
    .reverse()
    .map((x) => x.line || "");
  const template = (
    await q("SELECT env,variables FROM templates WHERE id=$1", [s.template_id])
  )[0];
  const secrets = { ...template?.env, ...s.variables };
  for (const def of template?.variables || [])
    if (def.secret && s.variables?.[def.key])
      secrets["secret:" + def.key] = s.variables[def.key];
  return {
    ...redactDiagnostics(s),
    console: logs.map((line) => redactConsole(line, secrets)),
  };
}
export async function createTicket(
  req: FastifyRequest,
  b: any,
  suspensionId?: string,
) {
  if (!suspensionId) await deskEnabled(req);
  const cfg = await supportSettings();
  const limits = await resolveLimits(req.actor!.id);
  if (!suspensionId && limits.values.mayOpenTickets === false)
    fail(403, "Your host has disabled new tickets for this account");
  const ticketCap = limits.values.ticketsPerDay ?? cfg.ticketsPerDay;
  if (!suspensionId)
    await supportRate("tickets:" + req.actor!.id, Number(ticketCap), 86400);
  await supportRate("create-ip:" + req.ip, 30, 3600);
  const subject = txt(b?.subject, 200),
    body = txt(b?.body, suspensionId ? 2000 : 20000);
  const category = suspensionId
    ? (
        await q(
          "SELECT * FROM support_categories WHERE name='Suspension appeal'",
        )
      )[0]
    : (
        await q("SELECT * FROM support_categories WHERE id=$1 AND public", [
          asId(b?.categoryId),
        ])
      )[0];
  if (!category) fail(400, "Choose a category");
  const tier =
    suspensionId || category.default_priority === "urgent"
      ? "urgent"
      : category.tier_id === "priority"
        ? "priority"
        : (
            await q(
              "SELECT p.support_tier FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND s.status IN ('active','trialing') ORDER BY p.support_tier DESC LIMIT 1",
              [req.actor!.id],
            )
          )[0]?.support_tier || "standard";
  const goal = (await q("SELECT * FROM support_tiers WHERE id=$1", [tier]))[0],
    calendar = await hours(),
    now = new Date();
  const diag = b?.serverId ? await diagnostics(req, b.serverId) : {};
  const c = await pool.connect();
  let t: any;
  try {
    await c.query("BEGIN");
    t = (
      await c.query(
        `INSERT INTO support_tickets(requester_user_id,requester_email,source,subject,category_id,priority,group_id,server_id,suspension_id,tier_id,first_reply_due_at,solve_due_at,diagnostics,last_customer_activity_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()) RETURNING *`,
        [
          req.actor!.id,
          req.actor!.email,
          suspensionId ? "suspension" : "panel",
          subject,
          category.id,
          suspensionId ? "urgent" : category.default_priority,
          category.group_id,
          b?.serverId || null,
          suspensionId || null,
          tier,
          addBusinessMinutes(now, goal.first_reply_minutes, calendar),
          addBusinessMinutes(now, goal.solve_minutes, calendar),
          JSON.stringify(b?.includeDiagnostics ? diag : {}),
        ],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO support_messages(ticket_id,author_user_id,author_kind,body) VALUES($1,$2,'customer',$3)",
      [t.id, req.actor!.id, body],
    );
    await c.query(
      "INSERT INTO support_events(ticket_id,kind,actor) VALUES($1,'created',$2)",
      [t.id, req.actor!.id],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  await mail(t, "support_received", "We received your message: " + subject);
  await emit({
    kind: t.suspension_id ? "suspension.appeal_created" : t.source === "abuse_form" ? "support.abuse_reported" : "support.ticket_created",
    title: `Ticket #${t.number}: ${subject}`,
    body: body.slice(0, 500),
    data: { ticketId: t.id },
  });
  await runRules(t.id, "created");
  await audit(req.actor!.id, "support.ticket.create", "ticket", t.id);
  if (suspensionId)
    for (const a of await q(
      "SELECT id,email FROM users WHERE role='admin' AND NOT disabled AND (is_super OR admin_permissions IS NULL OR 'support.view'=ANY(admin_permissions))",
    ))
      await sendTemplate(
        "suspension_appeal_received",
        a.email,
        {
          reference: "#" + t.number,
          message: body,
          link: `${WEB_ORIGIN}/support/${t.id}`,
        },
        { userId: a.id },
      );
  return customerTicket(t);
}
async function changeStatus(
  t: any,
  status: string,
  actor: string | null,
  fromRule = false,
) {
  if (!["open", "pending", "hold", "solved", "closed"].includes(status))
    fail(400, "Unknown ticket status");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const current = (
      await c.query("SELECT * FROM support_tickets WHERE id=$1 FOR UPDATE", [
        t.id,
      ])
    ).rows[0];
    if (!current) fail(404, "Ticket not found");
    Object.assign(t, current);
    if (t.status === status) {
      await c.query("COMMIT");
      return;
    }
    const cfg = await supportSettings();
    let replyDue = t.first_reply_due_at,
      solveDue = t.solve_due_at;
    if (t.paused_at && status !== "pending") {
      const calendar = await hours(),
        paused = businessMinutesBetween(
          new Date(t.paused_at),
          new Date(),
          calendar,
        );
      if (replyDue)
        replyDue = addBusinessMinutes(new Date(replyDue), paused, calendar);
      if (solveDue)
        solveDue = addBusinessMinutes(new Date(solveDue), paused, calendar);
    }
    await c.query(
      `UPDATE support_tickets SET status=$2,updated_at=now(),first_reply_due_at=$3,solve_due_at=$4,paused_at=CASE WHEN $2='pending' THEN COALESCE(paused_at,now()) ELSE NULL END,solved_at=CASE WHEN $2='solved' THEN now() WHEN $2='open' THEN NULL ELSE solved_at END,closed_at=CASE WHEN $2='closed' THEN now() WHEN $2='open' THEN NULL ELSE closed_at END,reopen_until=CASE WHEN $2='solved' THEN now()+make_interval(days=>$5) ELSE reopen_until END WHERE id=$1`,
      [t.id, status, replyDue, solveDue, cfg.reopenDays],
    );
    await c.query(
      "INSERT INTO support_events(ticket_id,kind,actor,data) VALUES($1,'status',$2,$3)",
      [t.id, actor, JSON.stringify({ before: t.status, after: status })],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  await emit({kind:status==="open"&&["solved","closed"].includes(t.status)?"support.reopened":"support.status_changed",title:`Ticket #${t.number}: ${status}`,recipientIds:t.requester_user_id?[t.requester_user_id]:[],data:{ticketId:t.id,status}});
  if (status === "solved") {
    await mail(
      t,
      "support_solved",
      "Your ticket has been marked as solved. You can reopen it from the panel.",
    );
    await mail(
      t,
      "support_rating",
      "How was your support experience? Rate your ticket in the panel.",
    );
  }
  if (status === "closed")
    await mail(t, "support_closed", "Your ticket has been closed.");
  if (!fromRule) await runRules(t.id, "status_changed");
}
async function setPriority(id: string, priority: string) {
  if (!["low", "normal", "high", "urgent"].includes(priority))
    fail(400, "Invalid priority");
  const t = (
    await q(
      "SELECT t.*,g.first_reply_minutes,g.solve_minutes FROM support_tickets t JOIN support_tiers g ON g.id=t.tier_id WHERE t.id=$1",
      [id],
    )
  )[0];
  const tier =
    priority === "urgent" || ["suspension", "abuse_form"].includes(t.source)
      ? "urgent"
      : (
          await q(
            "SELECT p.support_tier FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND s.status IN ('active','trialing') ORDER BY p.support_tier DESC LIMIT 1",
            [t.requester_user_id],
          )
        )[0]?.support_tier || "standard";
  const goal = (await q("SELECT * FROM support_tiers WHERE id=$1", [tier]))[0],
    calendar = await hours(),
    created = new Date(t.created_at);
  const pause = Math.max(
    0,
    businessMinutesBetween(created, new Date(t.solve_due_at), calendar) -
      t.solve_minutes,
  );
  await pool.query(
    "UPDATE support_tickets SET priority=$2,tier_id=$3,first_reply_due_at=$4,solve_due_at=$5,warning_sent_at=NULL,breach_sent_at=NULL,updated_at=now() WHERE id=$1",
    [
      id,
      priority,
      tier,
      addBusinessMinutes(created, goal.first_reply_minutes + pause, calendar),
      addBusinessMinutes(created, goal.solve_minutes + pause, calendar),
    ],
  );
}
export async function runRules(id: string, trigger: string) {
  for (const r of await q(
    "SELECT * FROM support_rules WHERE enabled AND trigger=$1 ORDER BY position,id",
    [trigger],
  )) {
    const t = (await q(ticketSelect + " WHERE t.id=$1", [id]))[0];
    if (!t) return;
    const c = r.conditions || {};
    if (trigger === "pending_days") {
      if (
        t.status !== "pending" ||
        !t.paused_at ||
        Date.now() - new Date(t.paused_at).getTime() <
          Number(c.days || 1) * 86400000
      )
        continue;
    }
    if (trigger === "deadline_percent") {
      if (!["open", "hold"].includes(t.status)) continue;
      const due = new Date(
          t.first_reply_at ? t.solve_due_at : t.first_reply_due_at,
        ),
        calendar = await hours(),
        total = businessMinutesBetween(new Date(t.created_at), due, calendar),
        used = total
          ? (businessMinutesBetween(
              new Date(t.created_at),
              new Date(),
              calendar,
            ) /
              total) *
            100
          : 100;
      if (used < Number(c.percent || 80)) continue;
    }
    if (
      ["pending_days", "deadline_percent"].includes(trigger) &&
      (
        await q(
          "SELECT 1 FROM support_events WHERE ticket_id=$1 AND kind='rule' AND data->>'ruleId'=$2 AND created_at>=COALESCE($3::timestamptz,$4::timestamptz)",
          [id, r.id, t.paused_at, t.created_at],
        )
      ).length
    )
      continue;
    if (
      (c.categoryId && c.categoryId !== t.category_id) ||
      (c.priority && c.priority !== t.priority) ||
      (c.groupId && c.groupId !== t.group_id) ||
      (c.tag && !t.tags.includes(c.tag))
    )
      continue;
    if (
      c.planId &&
      !(
        await q(
          "SELECT 1 FROM subscriptions WHERE user_id=$1 AND plan_id=$2 AND status IN ('active','trialing')",
          [t.requester_user_id, asId(c.planId)],
        )
      ).length
    )
      continue;
    if (
      c.textContains &&
      !(
        await q(
          "SELECT 1 FROM support_messages WHERE ticket_id=$1 AND body ILIKE $2 LIMIT 1",
          [id, "%" + c.textContains + "%"],
        )
      ).length
    )
      continue;
    for (const a of r.actions) {
      if (a.kind === "assign") {
        const changed=await pool.query(
          "UPDATE support_tickets SET assignee_id=$2 WHERE id=$1 AND assignee_id IS DISTINCT FROM $2 AND EXISTS(SELECT 1 FROM users WHERE id=$2 AND role='admin' AND NOT disabled) RETURNING id",
          [id, asId(a.value)],
        );
        if(changed.rowCount)await emit({kind:"support.assigned",title:`Ticket #${t.number} assignment changed`,data:{ticketId:t.id}});
      }
      if (a.kind === "group")
        await pool.query("UPDATE support_tickets SET group_id=$2 WHERE id=$1", [
          id,
          asId(a.value),
        ]);
      if (a.kind === "priority") await setPriority(id, a.value);
      if (a.kind === "status")
        await changeStatus(
          (await q(ticketSelect + " WHERE t.id=$1", [id]))[0],
          a.value,
          null,
          true,
        );
      if (a.kind === "tag")
        await pool.query(
          "UPDATE support_tickets SET tags=ARRAY(SELECT DISTINCT unnest(tags||ARRAY[$2::text])) WHERE id=$1",
          [id, txt(a.value, 50)],
        );
      if (a.kind === "note")
        await pool.query(
          "INSERT INTO support_messages(ticket_id,author_kind,kind,body) VALUES($1,'system','note',$2)",
          [id, txt(a.value, 2000)],
        );
      if (a.kind === "email")
        await mail(t, "support_nudge", txt(a.value, 2000));
      if (a.kind === "notify")
        await emit({
          kind: "support.deadline_warning",
          title: `Ticket #${t.number}`,
          body: txt(a.value, 2000),
          data: { ticketId: id },
        });
    }
    await event(id, "rule", null, { ruleId: r.id, name: r.name, trigger });
  }
}
export function supportRoutes(app: FastifyInstance) {
  supportInbound(app, { runRules, changeStatus });
  app.get("/api/support/config", async (req) => ({
    enabled: (await supportSettings()).enabled,
    categories: await q(
      "SELECT id,name,default_priority FROM support_categories WHERE public ORDER BY sort",
    ),
    tier:
      (
        await q(
          "SELECT p.support_tier FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND s.status IN ('active','trialing') ORDER BY p.support_tier DESC LIMIT 1",
          [req.actor!.id],
        )
      )[0]?.support_tier || "standard",
    hours: await hours(),
    ...(isAgent(req)
      ? {
          groups: await q("SELECT * FROM support_groups ORDER BY name"),
          agents: await q(
            "SELECT id,email,display_name FROM users WHERE role='admin' AND NOT disabled",
          ),
        }
      : {}),
  }));
  app.get("/api/support/tickets", async (req) => {
    const b = req.query as any,
      agent = isAgent(req);
    if (agent) can(req, "support.view");
    else await deskEnabled(req);
    const params: any[] = [],
      clauses: string[] = [];
    const add = (sql: string, v: any) => {
      params.push(v);
      clauses.push(sql.replace("?", `$${params.length}`));
    };
    if (!agent) add("t.requester_user_id=?", req.actor!.id);
    else {
      if (!(await supportSettings()).enabled)
        clauses.push("t.suspension_id IS NOT NULL");
      if (b.view === "mine") add("t.assignee_id=?", req.actor!.id);
      if (b.view === "unassigned") clauses.push("t.assignee_id IS NULL");
      if (b.view === "appeals") clauses.push("t.suspension_id IS NOT NULL");
      if (b.view === "needs-answer") clauses.push("t.status='open'");
      if (b.view === "pending") clauses.push("t.status='pending'");
      if (b.view === "solved") clauses.push("t.status IN ('solved','closed')");
      if (b.view === "deadline")
        clauses.push(
          "t.status IN ('open','hold') AND LEAST(t.first_reply_due_at,t.solve_due_at)<now()+interval '1 hour'",
        );
    }
    for (const [key, col] of [
      ["status", "status"],
      ["priority", "priority"],
      ["categoryId", "category_id"],
      ["assigneeId", "assignee_id"],
      ["groupId", "group_id"],
    ])
      if (b[key] && agent) add(`t.${col}=?`, b[key]);
    if (b.tag && agent) add("?=ANY(t.tags)", b.tag);
    if (b.search) {
      params.push(txt(b.search, 200));
      const k = "$" + params.length;
      clauses.push(
        `(t.number::text=regexp_replace(${k},'^#','') OR EXISTS(SELECT 1 FROM servers linked WHERE linked.id=t.server_id AND to_tsvector('simple',linked.name) @@ plainto_tsquery('simple',${k})) OR to_tsvector('simple',t.subject) @@ plainto_tsquery('simple',${k}) OR EXISTS(SELECT 1 FROM support_messages m WHERE m.ticket_id=t.id AND ${agent ? "true" : "m.kind='reply'"} AND to_tsvector('simple',m.body) @@ plainto_tsquery('simple',${k})) ${agent ? `OR u.email ILIKE '%'||${k}||'%'` : ""})`,
      );
    }
    if (agent) params.push(req.actor!.id);
    const rows = await q(
      (agent
        ? ticketSelect.replace(
            "SELECT t.*",
            `SELECT t.*, COALESCE(t.last_customer_activity_at>COALESCE((SELECT read_at FROM support_ticket_reads WHERE ticket_id=t.id AND user_id=$${params.length}),'epoch'),false) AS unread`,
          )
        : ticketSelect) +
        (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
        ` ORDER BY ${agent && b.sort === "deadline" ? "LEAST(t.first_reply_due_at,t.solve_due_at) NULLS LAST," : ""} t.updated_at DESC,t.id LIMIT 100 OFFSET ${Math.min(100000, Math.max(0, Number.parseInt(b.offset || "0", 10) || 0))}`,
      params,
    );
    return agent ? rows : rows.map(customerTicket);
  });
  app.post("/api/support/tickets", async (req) => createTicket(req, req.body));
  app.get("/api/support/tickets/:id", async (req) => {
    const t = await access(req, (req.params as any).id),
      agent = isAgent(req);
    const messages = await q(
      "SELECT m.*,u.display_name,u.email FROM support_messages m LEFT JOIN users u ON u.id=m.author_user_id WHERE m.ticket_id=$1" +
        (agent ? "" : " AND m.kind='reply'") +
        " ORDER BY m.created_at,m.id",
      [t.id],
    );
    const attachments = await q(
      "SELECT a.id,a.message_id,a.name,a.mime,a.size FROM support_attachments a JOIN support_messages m ON m.id=a.message_id WHERE a.ticket_id=$1" +
        (agent ? "" : " AND m.kind='reply'"),
      [t.id],
    );
    if (!agent)
      return {
        ...customerTicket(t),
        messages: messages.map(customerMessage),
        attachments,
      };
    await pool.query(
      "INSERT INTO support_ticket_reads(ticket_id,user_id) VALUES($1,$2) ON CONFLICT(ticket_id,user_id) DO UPDATE SET read_at=now()",
      [t.id, req.actor!.id],
    );
    await pool.query(
      "INSERT INTO support_presence(ticket_id,user_id) VALUES($1,$2) ON CONFLICT(ticket_id,user_id) DO UPDATE SET seen_at=now()",
      [t.id, req.actor!.id],
    );
    const context = t.requester_user_id
      ? {
          customer: (
            await q(
              "SELECT id,email,created_at,status FROM users WHERE id=$1",
              [t.requester_user_id],
            )
          )[0],
          servers:
            req.actor!.isSuper ||
            req.actor!.permissions?.includes("servers.view")
              ? await q(
                  "SELECT id,name,observed_status,suspended FROM servers WHERE owner_id=$1 AND deleted_at IS NULL",
                  [t.requester_user_id],
                )
              : [],
          invoices:
            req.actor!.isSuper ||
            req.actor!.permissions?.includes("billing.view")
              ? await q(
                  "SELECT number,status,amount_due,currency FROM invoices WHERE user_id=$1 AND status='open'",
                  [t.requester_user_id],
                )
              : [],
          subscriptions:
            req.actor!.isSuper ||
            req.actor!.permissions?.includes("billing.view")
              ? await q(
                  "SELECT s.id,s.status,p.name AS plan,s.amount AS price_cents,s.currency,s.cycle FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND s.status IN ('active','trialing','past_due','suspended')",
                  [t.requester_user_id],
                )
              : [],
          suspension: t.suspension_id
            ? (
                await q(
                  "SELECT reference,reason,lifted_at FROM account_suspensions WHERE id=$1",
                  [t.suspension_id],
                )
              )[0]
            : null,
          otherTickets: await q(
            "SELECT id,number,subject,status FROM support_tickets WHERE requester_user_id=$1 AND id<>$2 ORDER BY updated_at DESC LIMIT 10",
            [t.requester_user_id, t.id],
          ),
        }
      : {
          servers:
            t.server_id &&
            (req.actor!.isSuper ||
              req.actor!.permissions?.includes("servers.view"))
              ? await q(
                  "SELECT id,name,observed_status,suspended FROM servers WHERE id=$1 AND deleted_at IS NULL",
                  [t.server_id],
                )
              : [],
        };
    return {
      ...t,
      messages,
      attachments,
      context,
      linkedTickets: await q(
        "SELECT id,number,subject,status FROM support_tickets WHERE id=ANY($1::uuid[])",
        [t.linked_ticket_ids],
      ),
      events: await q(
        "SELECT * FROM support_events WHERE ticket_id=$1 ORDER BY id",
        [t.id],
      ),
      viewers: await q(
        "SELECT u.id,u.display_name,u.email FROM support_presence p JOIN users u ON u.id=p.user_id WHERE p.ticket_id=$1 AND p.user_id<>$2 AND p.seen_at>now()-interval '45 seconds'",
        [t.id, req.actor!.id],
      ),
    };
  });
  registerThreads(app);
  registerKnowledge(app);
  registerDeskSettings(app);
}
function registerThreads(app: FastifyInstance) {
  app.post("/api/support/tickets/:id/messages", async (req) => {
    const t = await access(req, (req.params as any).id),
      b = req.body as any,
      agent = isAgent(req);
    if (agent) can(req, "support.reply");
    if (["solved", "closed"].includes(t.status))
      fail(409, "Reopen the ticket before replying");
    if (!agent && b?.kind && b.kind !== "reply")
      fail(403, "Customers cannot post internal notes");
    const kind = agent && b?.kind === "note" ? "note" : "reply",
      body = txt(b?.body, t.suspension_id ? 2000 : 20000);
    await supportRate("replies:" + req.actor!.id + ":" + t.id, 10, 60);
    const c = await pool.connect();
    let message: any;
    try {
      await c.query("BEGIN");
      await c.query("SELECT id FROM support_tickets WHERE id=$1 FOR UPDATE", [
        t.id,
      ]);
      message = (
        await c.query(
          "INSERT INTO support_messages(ticket_id,author_user_id,author_kind,kind,body) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [t.id, req.actor!.id, agent ? "agent" : "customer", kind, body],
        )
      ).rows[0];
      if (b.attachments) {
        if (!Array.isArray(b.attachments) || b.attachments.length > 10)
          fail(400, "At most ten attachments");
        for (const id of b.attachments) {
          const r = await c.query(
            "UPDATE support_attachments SET message_id=$2 WHERE id=$1 AND ticket_id=$3 AND message_id IS NULL AND uploaded_by=$4 RETURNING id",
            [asId(id), message.id, t.id, req.actor!.id],
          );
          if (!r.rowCount) fail(404, "Attachment not found");
        }
      }
      await c.query(
        `UPDATE support_tickets SET updated_at=now(),${agent ? "last_agent_activity_at" : "last_customer_activity_at"}=now(),first_reply_at=CASE WHEN $2 AND $3='reply' THEN COALESCE(first_reply_at,now()) ELSE first_reply_at END WHERE id=$1`,
        [t.id, agent, kind],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    if (kind === "reply") {
      if (!agent && t.status === "pending")
        await changeStatus(t, "open", req.actor!.id);
      if (agent && b?.status) await changeStatus(t, b.status, req.actor!.id);
      await runRules(t.id, agent ? "agent_replied" : "customer_replied");
      if (agent) {
        await emit({kind:t.suspension_id?"suspension.appeal_replied":"support.agent_replied",title:`Reply to #${t.number}`,recipientIds:t.requester_user_id?[t.requester_user_id]:[],data:{ticketId:t.id},dedupe:{key:"reply:"+message.id,minutes:1440}});
        await mail(
          t,
          t.suspension_id ? "suspension_reply" : "support_reply",
          body,
        );

      } else
        await emit({
          kind: t.suspension_id?"suspension.appeal_replied":"support.customer_replied",
          recipientIds:[],
          title: `Reply to #${t.number}`,
          data: { ticketId: t.id },
        });
    }
    if (t.suspension_id)
      await pool.query(
        "INSERT INTO account_suspension_events(suspension_id,kind,actor,data) VALUES($1,$2,$3,$4)",
        [
          t.suspension_id,
          agent ? "reply" : "appeal",
          req.actor!.id,
          JSON.stringify({ ticketId: t.id, messageId: message.id }),
        ],
      );
    await audit(req.actor!.id, "support.message", "ticket", t.id, { kind });
    return agent ? message : customerMessage(message);
  });
  app.patch("/api/support/tickets/:id", async (req) => {
    const t = await access(req, (req.params as any).id),
      b = req.body as any;
    if (!isAgent(req)) {
      if (
        Object.keys(b || {}).some((k) => k !== "status") ||
        b.status !== "solved" ||
        ["solved", "closed"].includes(t.status)
      )
        fail(403, "Customers may only mark their ticket solved");
      await changeStatus(t, "solved", req.actor!.id);
      return { ok: true };
    }
    can(req, "support.assign");
    if (b.status) await changeStatus(t, b.status, req.actor!.id);
    for (const [key, col] of [
      ["assigneeId", "assignee_id"],
      ["groupId", "group_id"],
      ["priority", "priority"],
      ["tags", "tags"],
      ["linkedTicketIds", "linked_ticket_ids"],
    ])
      if (b[key] !== undefined) {
        let v = b[key];
        if (["assigneeId", "groupId"].includes(key) && v !== null) v = asId(v);
        if (
          key === "assigneeId" &&
          v &&
          !(
            await q(
              "SELECT 1 FROM users WHERE id=$1 AND role='admin' AND NOT disabled",
              [v],
            )
          ).length
        )
          fail(400, "Assignee must be an active administrator");
        if (
          key === "priority" &&
          !["low", "normal", "high", "urgent"].includes(v)
        )
          fail(400, "Invalid priority");
        if (["tags", "linkedTicketIds"].includes(key)) {
          if (!Array.isArray(v) || v.length > 20)
            fail(400, "At most twenty values");
          v = v.map((x: any) => (key === "tags" ? txt(x, 50) : asId(x)));
        }
        if (key === "priority") await setPriority(t.id, v);
        else
          await pool.query(
            `UPDATE support_tickets SET ${col}=$2,updated_at=now() WHERE id=$1`,
            [t.id, v],
          );
        await event(t.id, key, req.actor!.id, { before: t[col], after: v });
        if(key==="assigneeId")await emit({kind:"support.assigned",title:`Assignment changed for #${t.number}`,data:{ticketId:t.id}});
      }
    await audit(req.actor!.id, "support.ticket.update", "ticket", t.id, b);
    return { ok: true };
  });
  app.post("/api/support/tickets/bulk", async (req) => {
    can(req, "support.assign");
    const b = req.body as any;
    if (!Array.isArray(b?.ids) || !b.ids.length || b.ids.length > 100)
      fail(400, "Select one to one hundred tickets");
    if (
      b.assigneeId &&
      !(
        await q(
          "SELECT 1 FROM users WHERE id=$1 AND role='admin' AND NOT disabled",
          [asId(b.assigneeId)],
        )
      ).length
    )
      fail(400, "Invalid assignee");
    for (const id of b.ids) {
      const t = await access(req, id);
      if (b.status) await changeStatus(t, b.status, req.actor!.id);
      if (b.assigneeId !== undefined)
        await pool.query(
          "UPDATE support_tickets SET assignee_id=$2,updated_at=now() WHERE id=$1",
          [t.id, b.assigneeId === null ? null : asId(b.assigneeId)],
        );
      if (b.priority) {
        if (!["low", "normal", "high", "urgent"].includes(b.priority))
          fail(400, "Invalid priority");
        await setPriority(t.id, b.priority);
      }
      if (b.tag)
        await pool.query(
          "UPDATE support_tickets SET tags=ARRAY(SELECT DISTINCT unnest(tags||ARRAY[$2::text])) WHERE id=$1",
          [t.id, txt(b.tag, 50)],
        );
      if(b.assigneeId!==undefined&&b.assigneeId!==t.assignee_id)await emit({kind:"support.assigned",title:`Ticket #${t.number} assignment changed`,data:{ticketId:t.id}});
      await event(t.id, "bulk", req.actor!.id, b);
      await audit(req.actor!.id, "support.bulk", "ticket", t.id, b);
    }
    return { ok: true };
  });
  app.post("/api/support/tickets/:id/reopen", async (req) => {
    const t = await access(req, (req.params as any).id),
      agent = isAgent(req),
      appeal = !!t.suspension_id && !!req.actor!.suspended;
    if (agent) can(req, "support.reply");
    if (
      !["solved", "closed"].includes(t.status) ||
      (!agent &&
        !appeal &&
        (t.status !== "solved" ||
          !t.reopen_until ||
          new Date(t.reopen_until).getTime() < Date.now()))
    )
      fail(409, "The reopen window has ended");
    if (appeal) {
      const cfg = await suspensionSettings();
      if (!cfg.appealsEnabled) fail(403, "Appeals are disabled");
      await supportRate(
        "appeal-reopen:" + req.actor!.id,
        cfg.appealsPerDay,
        86400,
      );
    }
    await changeStatus(t, "open", req.actor!.id);
    await audit(req.actor!.id, "support.reopen", "ticket", t.id);
    return { ok: true };
  });
  app.post("/api/support/tickets/:id/rating", async (req) => {
    const t = await access(req, (req.params as any).id);
    if (
      t.requester_user_id !== req.actor!.id ||
      !["solved", "closed"].includes(t.status)
    )
      fail(403, "Only the requester may rate a solved ticket");
    const b = req.body as any;
    if (!Number.isInteger(b?.rating) || b.rating < 1 || b.rating > 5)
      fail(400, "Choose one to five stars");
    const r = await pool.query(
      "UPDATE support_tickets SET rating=$2,rating_comment=$3 WHERE id=$1 AND rating IS NULL RETURNING id",
      [t.id, b.rating, String(b.comment || "").slice(0, 2000)],
    );
    if (!r.rowCount) fail(409, "Already rated");
    await emit({kind:"support.rated",title:`Ticket #${t.number} rated`,data:{ticketId:t.id,rating:b.rating}});
    if (b.rating <= 2)
      await emit({
        kind: "support.rating_low",
        title: `Low rating for #${t.number}`,
        data: { ticketId: t.id },
      });
    return { ok: true };
  });
  app.delete("/api/support/tickets/:id", async (req) => {
    can(req, "support.delete");
    const t = await access(req, (req.params as any).id);
    if (t.suspension_id)
      fail(409, "Suspension appeals are kept with their account history");
    await pool.query("DELETE FROM support_tickets WHERE id=$1", [t.id]);
    await audit(req.actor!.id, "support.ticket.delete", "ticket", t.id);
    return { ok: true };
  });
  app.get("/api/support/diagnostics/:id", async (req) => {
    await deskEnabled(req);
    return diagnostics(req, (req.params as any).id);
  });
  app.post("/api/support/tickets/:id/attachments", async (req) => {
    const t = await access(req, (req.params as any).id);
    if (isAgent(req)) can(req, "support.reply");
    const file = (await req.file())!;
    if (!file) fail(400, "Choose a file");
    const bytes = await file.toBuffer();
    if (file.file.truncated) fail(413, "File exceeds upload limit");
    const name = file.filename.replace(/[\r\n"\\/]/g, "_").slice(0, 200),
      mime = detectAttachment(bytes, name);
    if (!mime) fail(400, "This attachment type is not allowed");
    await supportRate("attachment-upload:" + req.actor!.id, 10, 3600);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "support-upload:" + req.actor!.id,
      ]);
      const daily = (
        await c.query(
          "SELECT coalesce(sum(size),0)::int AS bytes FROM support_attachments WHERE uploaded_by=$1 AND created_at>now()-interval '24 hours'",
          [req.actor!.id],
        )
      ).rows[0].bytes;
      if (daily + bytes.length > 50 * 1024 * 1024)
        fail(429, "Daily attachment limit is 50 MB");
      await c.query("SELECT id FROM support_tickets WHERE id=$1 FOR UPDATE", [
        t.id,
      ]);
      const total = (
        await c.query(
          "SELECT coalesce(sum(size),0)::int n FROM support_attachments WHERE ticket_id=$1",
          [t.id],
        )
      ).rows[0].n;
      if (total + bytes.length > 25 * 1024 * 1024)
        fail(413, "Ticket attachment limit is 25 MB");
      const a = (
        await c.query(
          "INSERT INTO support_attachments(ticket_id,sha256,mime,name,size,bytes,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,mime,size",
          [
            t.id,
            hash(bytes.toString("base64")),
            mime,
            name,
            bytes.length,
            bytes,
            req.actor!.id,
          ],
        )
      ).rows[0];
      await c.query("COMMIT");
      return a;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  });
  app.get(
    "/api/support/tickets/:id/attachments/:attachmentId",
    async (req, reply) => {
      const t = await access(req, (req.params as any).id),
        a = (
          await q(
            "SELECT a.*,m.kind FROM support_attachments a LEFT JOIN support_messages m ON m.id=a.message_id WHERE a.id=$1 AND a.ticket_id=$2",
            [asId((req.params as any).attachmentId), t.id],
          )
        )[0];
      if (!a || (!isAgent(req) && a.kind !== "reply"))
        fail(404, "Attachment not found");
      reply
        .header("content-type", a.mime)
        .header("content-disposition", `attachment; filename="${a.name}"`)
        .header("content-security-policy", "sandbox; default-src 'none'")
        .header("x-content-type-options", "nosniff");
      return a.bytes;
    },
  );
  app.get("/api/support/drafts/:id", async (req) => ({
    body:
      (
        await q(
          "SELECT body FROM support_drafts WHERE user_id=$1 AND ticket_id=$2",
          [req.actor!.id, txt((req.params as any).id, 80)],
        )
      )[0]?.body || {},
  }));
  app.put("/api/support/drafts/:id", async (req) => {
    const b = req.body;
    if (JSON.stringify(b).length > 22000) fail(400, "Draft too large");
    await pool.query(
      "INSERT INTO support_drafts(user_id,ticket_id,body) VALUES($1,$2,$3) ON CONFLICT(user_id,ticket_id) DO UPDATE SET body=EXCLUDED.body,updated_at=now()",
      [req.actor!.id, txt((req.params as any).id, 80), JSON.stringify(b)],
    );
    return { ok: true };
  });
  app.post("/api/suspension/appeal", async (req) => {
    const cfg = await suspensionSettings();
    if (!cfg.appealsEnabled) fail(403, "Appeals are disabled");
    const s = (
      await q(
        "SELECT * FROM account_suspensions WHERE user_id=$1 AND lifted_at IS NULL",
        [req.actor!.id],
      )
    )[0];
    if (!s) fail(404, "No active suspension");
    const existing = (
      await q("SELECT id FROM support_tickets WHERE suspension_id=$1", [s.id])
    )[0];
    if (existing) return { id: existing.id };
    await supportRate("appeal:" + req.actor!.id, cfg.appealsPerDay, 86400);
    const ticket = await createTicket(
      req,
      {
        subject: "Suspension appeal " + s.reference,
        body: (req.body as any)?.body,
      },
      s.id,
    );
    await pool.query(
      "INSERT INTO account_suspension_events(suspension_id,kind,actor,data) VALUES($1,'appeal',$2,$3)",
      [s.id, req.actor!.id, JSON.stringify({ ticketId: ticket.id })],
    );
    await audit(req.actor!.id, "suspension.appeal", "user", req.actor!.id, {
      reference: s.reference,
    });
    return ticket;
  });
}
function registerKnowledge(app: FastifyInstance) {
  app.get("/api/support/articles", async (req) => {
    await deskEnabled(req);
    const agent = isAgent(req);
    if (agent) can(req, "support.view");
    const b = req.query as any;
    return q(
      "SELECT id,slug,title,category,visibility,helpful_yes,helpful_no,updated_at FROM support_articles WHERE " +
        (agent ? "true" : "visibility IN ('customers','public')") +
        (b.category ? " AND category=$1" : "") +
        " ORDER BY helpful_yes DESC,title",
      b.category ? [txt(b.category)] : [],
    );
  });
  app.get("/api/support/articles/:slug", async (req) => {
    await deskEnabled(req);
    const a = (
      await q(
        "SELECT * FROM support_articles WHERE slug=$1" +
          (isAgent(req) ? "" : " AND visibility IN ('customers','public')"),
        [txt((req.params as any).slug, 100)],
      )
    )[0];
    if (!a) fail(404, "Article not found");
    return a;
  });
  app.get("/api/support/search", async (req) => {
    await deskEnabled(req);
    const term = txt((req.query as any)?.q, 200);
    const rows = await q(
      "SELECT id,slug,title,category,left(body,180) AS excerpt FROM support_articles WHERE visibility IN ('customers','public') AND to_tsvector('simple',title||' '||body) @@ plainto_tsquery('simple',$1) ORDER BY helpful_yes DESC LIMIT 15",
      [term],
    );
    await pool.query(
      "INSERT INTO support_article_search(query,count,no_results) VALUES($1,1,$2) ON CONFLICT(query) DO UPDATE SET count=support_article_search.count+1,no_results=support_article_search.no_results+EXCLUDED.no_results",
      [term.toLowerCase(), rows.length ? 0 : 1],
    );
    return rows;
  });
  app.post("/api/support/articles/:slug/vote", async (req) => {
    const a = (
      await q(
        "SELECT id FROM support_articles WHERE slug=$1 AND visibility IN ('customers','public')",
        [txt((req.params as any).slug, 100)],
      )
    )[0];
    if (!a) fail(404, "Article not found");
    const helpful = (req.body as any)?.helpful;
    if (typeof helpful !== "boolean") fail(400, "Expected helpful boolean");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        "INSERT INTO support_article_votes(article_id,user_id,helpful) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING article_id",
        [a.id, req.actor!.id, helpful],
      );
      if (r.rowCount)
        await c.query(
          `UPDATE support_articles SET ${helpful ? "helpful_yes" : "helpful_no"}=${helpful ? "helpful_yes" : "helpful_no"}+1 WHERE id=$1`,
          [a.id],
        );
      await c.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  });
  app.post("/api/support/articles", async (req) => {
    can(req, "support.articles");
    const b = req.body as any,
      slug = txt(b?.slug, 100);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      fail(400, "Use a lowercase article slug");
    if (!["customers", "public", "draft"].includes(b.visibility))
      fail(400, "Choose article visibility");
    const a = (
      await q(
        "INSERT INTO support_articles(slug,title,body,category,visibility,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,category=EXCLUDED.category,visibility=EXCLUDED.visibility,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING id",
        [
          slug,
          txt(b.title, 200),
          txt(b.body, 50000),
          txt(b.category || "General", 100),
          b.visibility,
          req.actor!.id,
        ],
      )
    )[0];
    await audit(req.actor!.id, "support.article.write", "article", a.id);
    return a;
  });
  app.delete("/api/support/articles/:slug", async (req) => {
    can(req, "support.articles");
    await pool.query("DELETE FROM support_articles WHERE slug=$1", [
      txt((req.params as any).slug, 100),
    ]);
    await audit(
      req.actor!.id,
      "support.article.delete",
      "article",
      (req.params as any).slug,
    );
    return { ok: true };
  });
  app.get("/api/support/public", async () => {
    const cfg = await supportSettings();
    if (!cfg.enabled || !cfg.publicHelp)
      fail(404, "Public help centre unavailable");
    return q(
      "SELECT slug,title,body,category FROM support_articles WHERE visibility='public' ORDER BY title",
    );
  });
  app.get("/api/support/abuse/config", async () => {
    const cfg = await supportSettings(),
      signup = (await settings()).signup;
    return {
      enabled:
        cfg.enabled && cfg.abuseEnabled && signup.captchaProvider !== "none",
      captcha:
        signup.captchaProvider === "none"
          ? null
          : {
              provider: signup.captchaProvider,
              siteKey: signup.captchaSiteKey,
            },
    };
  });
  app.post("/api/support/abuse", async (req) => {
    const cfg = await supportSettings(),
      signup = (await settings()).signup;
    if (!cfg.enabled || !cfg.abuseEnabled || signup.captchaProvider === "none")
      fail(403, "Abuse reports require an enabled desk and bot protection");
    await supportRate("abuse-ip:" + req.ip, 5, 3600);
    await supportRate("abuse-global", 100, 3600);
    const b = req.body as any,
      email = txt(b?.email, 254);
    if (!looksLikeEmail(email)) fail(400, "Valid email required");
    if (
      !(await verifyCaptcha(
        signup.captchaProvider as "turnstile" | "hcaptcha",
        signup.captchaSecret,
        signup.captchaSiteKey,
        b?.captcha,
        req.ip,
      ))
    )
      fail(400, "Complete the bot check");
    if (
      ![
        "spam",
        "attacks",
        "malware",
        "copyright",
        "harassment",
        "other",
      ].includes(b?.category)
    )
      fail(400, "Choose an abuse category");
    const body = txt(b?.body, 10000),
      address = txt(b?.address, 254);
    const cat = (
        await q("SELECT id FROM support_categories WHERE name='Abuse'")
      )[0],
      group = (await q("SELECT id FROM support_groups WHERE name='Abuse'"))[0],
      goal = (await q("SELECT * FROM support_tiers WHERE id='urgent'"))[0],
      calendar = await hours(),
      now = new Date();
    const server = (
      await q(
        "SELECT s.id FROM servers s JOIN nodes n ON n.id=s.node_id WHERE n.public_host||':'||s.port::text=$1 AND s.deleted_at IS NULL",
        [address],
      )
    )[0];
    const t = (
      await q(
        "INSERT INTO support_tickets(requester_email,source,subject,category_id,priority,group_id,server_id,tier_id,first_reply_due_at,solve_due_at) VALUES($1,'abuse_form',$2,$3,'urgent',$4,$5,'urgent',$6,$7) RETURNING *",
        [
          email,
          `Abuse: ${b.category} · ${address}`.slice(0, 200),
          cat.id,
          group.id,
          server?.id || null,
          addBusinessMinutes(now, goal.first_reply_minutes, calendar),
          addBusinessMinutes(now, goal.solve_minutes, calendar),
        ],
      )
    )[0];
    await pool.query(
      "INSERT INTO support_messages(ticket_id,author_kind,body) VALUES($1,'external',$2)",
      [t.id, body],
    );
    await event(t.id, "created", null);
    await emit({
      kind: t.suspension_id ? "suspension.appeal_created" : t.source === "abuse_form" ? "support.abuse_reported" : "support.ticket_created",
      title: `Abuse report #${t.number}`,
      data: { ticketId: t.id },
    });
    await runRules(t.id, "created");
    await mail(t, "support_received", "Your report has been received.");
    return { ok: true, number: t.number };
  });
}
function registerDeskSettings(app: FastifyInstance) {
  app.put("/api/support/groups/:id", async (req) => {
    can(req, "support.manage");
    const id = asId((req.params as any).id),
      b = req.body as any;
    if (!Array.isArray(b.members) || b.members.length > 100)
      fail(400, "Choose group members");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE support_groups SET name=$2 WHERE id=$1", [
        id,
        txt(b.name, 100),
      ]);
      await c.query("DELETE FROM support_group_members WHERE group_id=$1", [
        id,
      ]);
      for (const member of b.members)
        await c.query(
          "INSERT INTO support_group_members(group_id,user_id) SELECT $1,id FROM users WHERE id=$2 AND role='admin' AND NOT disabled",
          [id, asId(member)],
        );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    await audit(req.actor!.id, "support.group.update", "group", id);
    return { ok: true };
  });
  app.put("/api/support/categories/:id", async (req) => {
    can(req, "support.manage");
    const id = asId((req.params as any).id),
      b = req.body as any;
    if (!["low", "normal", "high", "urgent"].includes(b.defaultPriority))
      fail(400, "Choose priority");
    await pool.query(
      "UPDATE support_categories SET name=$2,group_id=$3,default_priority=$4,tier_id=$5,public=$6,sort=$7 WHERE id=$1",
      [
        id,
        txt(b.name, 100),
        b.groupId ? asId(b.groupId) : null,
        b.defaultPriority,
        txt(b.tierId, 40),
        b.public === true,
        Number.isInteger(b.sort) ? b.sort : 0,
      ],
    );
    await audit(req.actor!.id, "support.category.update", "category", id);
    return { ok: true };
  });
  app.put("/api/support/rules/:id", async (req) => {
    can(req, "support.manage");
    const id = asId((req.params as any).id),
      b = req.body as any;
    if (typeof b.enabled !== "boolean" || !Number.isInteger(b.position))
      fail(400, "Expected enabled and position");
    await pool.query(
      "UPDATE support_rules SET enabled=$2,position=$3 WHERE id=$1",
      [id, b.enabled, b.position],
    );
    await audit(req.actor!.id, "support.rule.update", "rule", id, b);
    return { ok: true };
  });
  app.get("/api/support/settings", async (req) => {
    can(req, "support.manage");
    return {
      settings: await supportSettings(),
      suspension: await suspensionSettings(),
      hours: await hours(),
      tiers: await q(
        "SELECT * FROM support_tiers ORDER BY first_reply_minutes",
      ),
      categories: await q("SELECT * FROM support_categories ORDER BY sort"),
      groups: await q(
        "SELECT g.*,ARRAY(SELECT user_id FROM support_group_members m WHERE m.group_id=g.id) AS members FROM support_groups g",
      ),
      rules: await q("SELECT * FROM support_rules ORDER BY position,id"),
      macros: await q(
        "SELECT * FROM support_macros WHERE scope='team' OR owner_id=$1",
        [req.actor!.id],
      ),
      plans: await q("SELECT id,name FROM plans WHERE active ORDER BY name"),
      agents: await q(
        "SELECT id,email,display_name FROM users WHERE role='admin' AND NOT disabled",
      ),
      inboundEmail: { enabled: await inboundEnabled() },
    };
  });
  app.get("/api/support/inbound/settings", async (req) => {
    can(req, "support.manage");
    return { enabled: await inboundEnabled() };
  });
  app.put("/api/support/inbound/settings", async (req) => {
    can(req, "support.manage");
    const enabled = (req.body as any)?.enabled;
    if (typeof enabled !== "boolean") fail(400, "enabled must be a boolean");
    const current = (await pool.query("SELECT secret FROM settings WHERE key='support_inbound'")).rows[0];
    let secret = current?.secret || null;
    if (enabled && !secret) {
      const legacy = process.env.SUPPORT_INBOUND_SECRET || "";
      if (legacy.length < 32) fail(409, "Generate an inbound email secret in this panel first");
      secret = encrypt(JSON.stringify({ key: legacy }));
    }
    await pool.query("INSERT INTO settings(key,value,secret,updated_by) VALUES('support_inbound',$1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,secret=coalesce(settings.secret,EXCLUDED.secret),updated_by=EXCLUDED.updated_by,updated_at=now()", [JSON.stringify({ enabled }), secret, req.actor!.id]);
    await audit(req.actor!.id, enabled ? "support.inbound.enable" : "support.inbound.disable", "settings", "support-inbound", { enabled });
    return { enabled: await inboundEnabled() };
  });
  app.post("/api/support/inbound/secret", async (req) => {
    can(req, "support.manage");
    const secret = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO settings(key,value,secret,updated_by) VALUES('support_inbound',$1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,secret=EXCLUDED.secret,updated_by=EXCLUDED.updated_by,updated_at=now()", [JSON.stringify({ enabled: false }), encrypt(JSON.stringify({ key: secret })), req.actor!.id]);
    await audit(req.actor!.id, "support.inbound.rotate", "settings", "support-inbound", { enabled: false });
    return { secret };
  });
  app.put("/api/support/settings", async (req) => {
    can(req, "support.manage");
    const value = validateSupport(req.body);
    await pool.query(
      "INSERT INTO settings(key,value) VALUES('support',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [JSON.stringify(value)],
    );
    await audit(
      req.actor!.id,
      "support.settings",
      "settings",
      "support",
      value,
    );
    return value;
  });
  app.put("/api/support/hours", async (req) => {
    can(req, "support.manage");
    let h: BusinessHours;
    try {
      h = validateHours(req.body);
    } catch (e: any) {
      return fail(400, e.message);
    }
    await pool.query(
      "UPDATE support_hours SET timezone=$1,weekly=$2,holidays=$3 WHERE id=1",
      [h.timezone, JSON.stringify(h.weekly), JSON.stringify(h.holidays)],
    );
    await audit(req.actor!.id, "support.hours", "settings", "support", h);
    return h;
  });
  app.put("/api/support/tiers/:id", async (req) => {
    can(req, "support.manage");
    const b = req.body as any;
    for (const k of ["firstReplyMinutes", "solveMinutes", "warnPercent"])
      if (
        !Number.isInteger(b?.[k]) ||
        b[k] < 1 ||
        b[k] > (k === "warnPercent" ? 100 : 10080)
      )
        fail(400, "Invalid tier goal");
    await pool.query(
      "UPDATE support_tiers SET first_reply_minutes=$2,solve_minutes=$3,warn_percent=$4 WHERE id=$1",
      [
        txt((req.params as any).id),
        b.firstReplyMinutes,
        b.solveMinutes,
        b.warnPercent,
      ],
    );
    await audit(
      req.actor!.id,
      "support.tier",
      "tier",
      (req.params as any).id,
      b,
    );
    return { ok: true };
  });
  app.get("/api/support/macros", async (req) => {
    can(req, "support.reply");
    return q(
      "SELECT * FROM support_macros WHERE scope='team' OR owner_id=$1 ORDER BY name",
      [req.actor!.id],
    );
  });
  app.post("/api/support/macros", async (req) => {
    can(req, "support.manage");
    const b = req.body as any;
    if (
      b.id &&
      !(
        await q(
          "SELECT 1 FROM support_macros WHERE id=$1 AND (scope='team' OR owner_id=$2)",
          [asId(b.id), req.actor!.id],
        )
      ).length
    )
      fail(404, "Macro not found");
    const m = (
      await q(
        "INSERT INTO support_macros(name,shortcut,body,scope,owner_id,id) VALUES($1,$2,$3,$4,$5,COALESCE($6::uuid,gen_random_uuid())) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,shortcut=EXCLUDED.shortcut,body=EXCLUDED.body,scope=EXCLUDED.scope RETURNING *",
        [
          txt(b?.name, 100),
          txt(b?.shortcut, 40),
          txt(b?.body, 20000),
          b.scope === "personal" ? "personal" : "team",
          req.actor!.id,
          b.id ? asId(b.id) : null,
        ],
      )
    )[0];
    await audit(req.actor!.id, "support.macro", "macro", m.id);
    return m;
  });
  app.delete("/api/support/macros/:id", async (req) => {
    can(req, "support.manage");
    await pool.query(
      "DELETE FROM support_macros WHERE id=$1 AND (scope='team' OR owner_id=$2)",
      [asId((req.params as any).id), req.actor!.id],
    );
    await audit(
      req.actor!.id,
      "support.macro.delete",
      "macro",
      (req.params as any).id,
    );
    return { ok: true };
  });
  app.post("/api/support/groups", async (req) => {
    can(req, "support.manage");
    const b = req.body as any;
    const g = (
      await q("INSERT INTO support_groups(name) VALUES($1) RETURNING *", [
        txt(b?.name, 100),
      ])
    )[0];
    if (b.members) {
      if (!Array.isArray(b.members) || b.members.length > 100)
        fail(400, "Invalid members");
      for (const id of b.members)
        await pool.query(
          "INSERT INTO support_group_members(group_id,user_id) SELECT $1,id FROM users WHERE id=$2 AND role='admin'",
          [g.id, asId(id)],
        );
    }
    await audit(req.actor!.id, "support.group", "group", g.id);
    return g;
  });
  app.post("/api/support/categories", async (req) => {
    can(req, "support.manage");
    const b = req.body as any;
    if (
      !["low", "normal", "high", "urgent"].includes(
        b?.defaultPriority || "normal",
      )
    )
      fail(400, "Invalid priority");
    const a = (
      await q(
        "INSERT INTO support_categories(name,group_id,default_priority,tier_id,public,sort) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          txt(b?.name, 100),
          b.groupId ? asId(b.groupId) : null,
          b.defaultPriority || "normal",
          b.tierId || "standard",
          b.public !== false,
          Number.isInteger(b.sort) ? b.sort : 0,
        ],
      )
    )[0];
    await audit(req.actor!.id, "support.category", "category", a.id);
    return a;
  });
  app.post("/api/support/rules", async (req) => {
    can(req, "support.manage");
    const b = req.body as any;
    if (
      ![
        "created",
        "customer_replied",
        "agent_replied",
        "status_changed",
        "pending_days",
        "deadline_percent",
      ].includes(b?.trigger)
    )
      fail(400, "Invalid rule trigger");
    if (
      !Array.isArray(b.actions) ||
      b.actions.length > 10 ||
      !b.conditions ||
      typeof b.conditions !== "object" ||
      Object.keys(b.conditions).some(
        (k) =>
          ![
            "categoryId",
            "priority",
            "groupId",
            "tag",
            "textContains",
            "days",
            "percent",
            "planId",
          ].includes(k),
      )
    )
      fail(400, "Invalid rule");
    for (const a of b.actions) {
      if (
        ![
          "assign",
          "group",
          "priority",
          "status",
          "tag",
          "email",
          "notify",
          "note",
        ].includes(a.kind) ||
        typeof a.value !== "string"
      )
        fail(400, "Invalid rule action");
      if (
        (a.kind === "priority" &&
          !["low", "normal", "high", "urgent"].includes(a.value)) ||
        (a.kind === "status" &&
          !["open", "pending", "hold", "solved", "closed"].includes(a.value))
      )
        fail(400, "Invalid rule value");
      if (["assign", "group"].includes(a.kind)) asId(a.value);
      if (a.value.length > 2000) fail(400, "Rule value too long");
    }
    for (const [k, max] of [
      ["days", 3650],
      ["percent", 100],
    ] as const)
      if (
        b.conditions[k] !== undefined &&
        (!Number.isInteger(b.conditions[k]) ||
          b.conditions[k] < 1 ||
          b.conditions[k] > max)
      )
        fail(400, "Invalid temporal rule threshold");
    const r = (
      await q(
        "INSERT INTO support_rules(name,enabled,position,trigger,conditions,actions,id) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::uuid,gen_random_uuid())) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,position=EXCLUDED.position,trigger=EXCLUDED.trigger,conditions=EXCLUDED.conditions,actions=EXCLUDED.actions RETURNING *",
        [
          txt(b.name, 100),
          b.enabled !== false,
          Number.isInteger(b.position) ? b.position : 0,
          b.trigger,
          JSON.stringify(b.conditions),
          JSON.stringify(b.actions),
          b.id ? asId(b.id) : null,
        ],
      )
    )[0];
    await audit(req.actor!.id, "support.rule", "rule", r.id, b);
    return r;
  });
  app.delete("/api/support/rules/:id", async (req) => {
    can(req, "support.manage");
    await pool.query("DELETE FROM support_rules WHERE id=$1", [
      asId((req.params as any).id),
    ]);
    await audit(
      req.actor!.id,
      "support.rule.delete",
      "rule",
      (req.params as any).id,
    );
    return { ok: true };
  });
  app.get("/api/support/reports", async (req, reply) => {
    can(req, "support.reports");
    const daily = await q(
      "SELECT d.day,(SELECT count(*)::int FROM support_tickets WHERE created_at::date=d.day) AS received,(SELECT count(*)::int FROM support_tickets WHERE solved_at::date=d.day) AS solved,(SELECT avg(extract(epoch FROM first_reply_at-created_at)) FROM support_tickets WHERE first_reply_at::date=d.day) AS first_reply_seconds,(SELECT avg(extract(epoch FROM solved_at-created_at)) FROM support_tickets WHERE solved_at::date=d.day) AS resolution_seconds,(SELECT avg(rating) FROM support_tickets WHERE solved_at::date=d.day) AS rating,(SELECT count(*)::int FROM support_tickets WHERE solved_at::date=d.day AND first_reply_at<=first_reply_due_at AND solved_at<=solve_due_at) AS deadline_met FROM (SELECT generate_series(current_date-29,current_date,interval '1 day')::date AS day) d ORDER BY d.day",
    );
    if ((req.query as any)?.format === "csv") {
      reply
        .header("content-type", "text/csv")
        .header(
          "content-disposition",
          'attachment; filename="support-report.csv"',
        );
      return (
        "day,received,solved,first_reply_seconds,resolution_seconds,rating,deadline_met\n" +
        daily
          .map((d) =>
            [
              new Date(d.day).toISOString().slice(0, 10),
              d.received,
              d.solved,
              d.first_reply_seconds,
              d.resolution_seconds,
              d.rating,
              d.deadline_met,
            ].join(","),
          )
          .join("\n")
      );
    }
    return {
      daily,
      byCategory: await q(
        "SELECT c.name,count(*)::int AS tickets FROM support_tickets t LEFT JOIN support_categories c ON c.id=t.category_id WHERE t.created_at>=now()-interval '30 days' GROUP BY c.name",
      ),
      byAgent: await q(
        "SELECT u.email,count(*)::int AS tickets,avg(t.rating) AS rating FROM support_tickets t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.created_at>=now()-interval '30 days' GROUP BY u.email",
      ),
      articleFeedback: (
        await q(
          "SELECT COALESCE(sum(helpful_yes),0)::int AS helpful,COALESCE(sum(helpful_no),0)::int AS unhelpful FROM support_articles",
        )
      )[0],
      unansweredSearches: await q(
        "SELECT * FROM support_article_search WHERE no_results>0 ORDER BY no_results DESC LIMIT 20",
      ),
    };
  });
}
export async function sweepSupport() {
  const cfg = await supportSettings();
  for (const t of await q(
    "SELECT t.*,g.warn_percent FROM support_tickets t JOIN support_tiers g ON g.id=t.tier_id WHERE t.status IN ('open','hold') AND (t.warning_sent_at IS NULL OR t.breach_sent_at IS NULL) ORDER BY LEAST(t.first_reply_due_at,t.solve_due_at) LIMIT 100",
  )) {
    const calendar = await hours(),
      due = new Date(
        t.first_reply_at ? t.solve_due_at : t.first_reply_due_at,
      ).getTime(),
      created = new Date(t.created_at).getTime(),
      total = businessMinutesBetween(
        new Date(created),
        new Date(due),
        calendar,
      ),
      used = total
        ? (businessMinutesBetween(new Date(created), new Date(), calendar) /
            total) *
          100
        : 100;
    if (used >= t.warn_percent && !t.warning_sent_at) {
      await emit({
        kind: "support.deadline_warning",
        title: `Ticket #${t.number} approaching deadline`,
        data: { ticketId: t.id },
        dedupe: { key: "support-warning:" + t.id, minutes: 1440 },
      });
      await pool.query(
        "UPDATE support_tickets SET warning_sent_at=now() WHERE id=$1",
        [t.id],
      );
      for (const agent of await q(
        "SELECT id,email FROM users WHERE role='admin' AND NOT disabled AND (is_super OR admin_permissions IS NULL OR 'support.view'=ANY(admin_permissions))",
      ))
        await sendTemplate(
          "support_deadline_warning",
          agent.email,
          {
            reference: "#" + t.number,
            message: "A support deadline needs attention.",
            link: `${WEB_ORIGIN}/support/${t.id}`,
          },
          {
            userId: agent.id,
            dedupeKey: "support-warning:" + t.id + ":" + agent.id,
          },
        );
      await event(t.id, "deadline_warning", null);
    }
    if (Date.now() > due && !t.breach_sent_at) {
      await emit({
        kind: "support.deadline_breached",
        title: `Ticket #${t.number} overdue`,
        data: { ticketId: t.id },
        dedupe: { key: "support-breach:" + t.id, minutes: 1440 },
      });
      await pool.query(
        "UPDATE support_tickets SET breach_sent_at=now() WHERE id=$1",
        [t.id],
      );
      await event(t.id, "deadline_breached", null);
    }
  }
  for (const t of await q(
    "SELECT * FROM support_tickets WHERE status='pending' AND paused_at<now()-make_interval(days=>$1) AND (paused_at<now()-make_interval(days=>$2) OR NOT EXISTS(SELECT 1 FROM support_events e WHERE e.ticket_id=support_tickets.id AND e.kind='nudge' AND e.created_at>support_tickets.paused_at)) ORDER BY paused_at LIMIT 50",
    [cfg.pendingNudgeDays, cfg.pendingCloseDays],
  )) {
    if (
      !(
        await q(
          "SELECT 1 FROM support_events WHERE ticket_id=$1 AND kind='nudge' AND created_at>$2",
          [t.id, t.paused_at],
        )
      ).length
    ) {
      await mail(t, "support_nudge", "We are waiting for your reply.");
      await event(t.id, "nudge", null);
    }
    if (
      new Date(t.paused_at).getTime() <
      Date.now() - cfg.pendingCloseDays * 86400000
    )
      await changeStatus(t, "closed", null);
  }
  for (const t of await q(
    "SELECT id FROM support_tickets WHERE status IN ('open','pending','hold') ORDER BY updated_at",
  )) {
    await runRules(t.id, "pending_days");
    await runRules(t.id, "deadline_percent");
  }
  await pool.query(
    "UPDATE support_events SET actor=NULL,data='{}' WHERE ticket_id IN (SELECT id FROM support_tickets WHERE status='closed' AND suspension_id IS NULL AND closed_at<now()-make_interval(days=>$1))",
    [cfg.retentionDays],
  );
  await pool.query(
    "DELETE FROM support_drafts WHERE ticket_id IN (SELECT id::text FROM support_tickets WHERE status='closed' AND suspension_id IS NULL AND closed_at<now()-make_interval(days=>$1))",
    [cfg.retentionDays],
  );
  await pool.query(
    "UPDATE support_tickets SET subject='[Removed after retention period]',requester_email='removed@deleted.invalid',requester_user_id=NULL,rating_comment=NULL,diagnostics='{}' WHERE status='closed' AND suspension_id IS NULL AND closed_at<now()-make_interval(days=>$1)",
    [cfg.retentionDays],
  );
  await pool.query(
    "DELETE FROM support_attachments WHERE ticket_id IN (SELECT id FROM support_tickets WHERE status='closed' AND suspension_id IS NULL AND closed_at<now()-make_interval(days=>$1))",
    [cfg.retentionDays],
  );
  await pool.query(
    "UPDATE support_messages SET body='[Removed after retention period]',author_user_id=NULL WHERE ticket_id IN (SELECT id FROM support_tickets WHERE status='closed' AND suspension_id IS NULL AND closed_at<now()-make_interval(days=>$1))",
    [cfg.retentionDays],
  );
}
