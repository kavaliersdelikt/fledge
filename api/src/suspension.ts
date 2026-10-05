import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { pool, can, fail, txt, asId, audit, WEB_ORIGIN } from "./core.js";
import { sendTemplate } from "./email.js";
import { emit } from "./notifications.js";
export const REASONS = [
  "billing",
  "terms",
  "security",
  "review",
  "requested",
  "other",
] as const;
export type SuspensionOptions = {
  reason: string;
  message: string;
  internalNote?: string;
  stopServers?: boolean;
  allowBackupDownload?: boolean;
  allowAccountDeletion?: boolean;
  liftOnPayment?: boolean;
  notify?: boolean;
  until?: string | null;
  source?: string;
};
export const defaultSuspension = {
  retentionDays: 0,
  appealsEnabled: true,
  appealsPerDay: 1,
  defaultServers: true,
  autoTerminate: false,
};
export async function suspensionSettings() {
  return {
    ...defaultSuspension,
    ...(await pool.query("SELECT value FROM settings WHERE key='suspension'"))
      .rows[0]?.value,
  };
}
export function suspensionShape(s: any) {
  return {
    id: s.id,
    reference: s.reference,
    reason: s.reason,
    message: s.message,
    stopServers: s.stop_servers,
    allowBackupDownload: s.allow_backup_download,
    allowAccountDeletion: s.allow_account_deletion,
    liftOnPayment: s.lift_on_payment,
    until: s.until,
    createdAt: s.created_at,
    liftedAt: s.lifted_at,
    displayName: s.display_name || "Your host",
  };
}
async function mail(s: any, restored = false) {
  const u = (
    await pool.query("SELECT email FROM users WHERE id=$1", [s.user_id])
  ).rows[0];
  if (!u) return;
  const r = await sendTemplate(
    restored ? "account_restored" : "account_suspended",
    u.email,
    {
      reference: s.reference,
      message: restored
        ? s.lift_note || "Your account is available again."
        : s.message,
      reason: s.reason,
      link: WEB_ORIGIN,
    },
    {
      userId: s.user_id,
      dedupeKey: `suspension:${s.id}:${restored ? "restored" : "created"}`,
    },
  );
  await pool.query(
    "INSERT INTO account_suspension_events(suspension_id,kind,data) VALUES($1,'email',$2)",
    [s.id, JSON.stringify(r)],
  );
}
export async function suspendAccount(
  userId: string,
  actor: string | null,
  input: SuspensionOptions,
) {
  if (!REASONS.includes(input.reason as any))
    fail(400, "Unknown suspension reason");
  const message = txt(input.message, 2000),
    internal =
      input.internalNote === undefined ? "" : String(input.internalNote);
  if (internal.length > 2000) fail(400, "Internal note is too long");
  if (
    input.until &&
    (!Number.isFinite(Date.parse(input.until)) ||
      Date.parse(input.until) <= Date.now())
  )
    fail(400, "Lift date must be in the future");
  for (const k of [
    "stopServers",
    "allowBackupDownload",
    "allowAccountDeletion",
    "liftOnPayment",
    "notify",
  ] as const)
    if (input[k] !== undefined && typeof input[k] !== "boolean")
      fail(400, k + " must be boolean");
  const c = await pool.connect();
  let s: any;
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "suspension:" + userId,
    ]);
    const u = (
      await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId])
    ).rows[0];
    if (!u || u.role !== "customer")
      fail(403, "Only customer accounts can be suspended");
    if (!["active", "suspended"].includes(u.status))
      fail(409, "Account must be active");
    if (
      (
        await c.query(
          "SELECT 1 FROM account_suspensions WHERE user_id=$1 AND lifted_at IS NULL",
          [userId],
        )
      ).rowCount
    )
      fail(409, "This account already has a suspension");
    const servers = (
      await c.query(
        "SELECT * FROM servers WHERE owner_id=$1 AND deleted_at IS NULL FOR UPDATE",
        [userId],
      )
    ).rows;
    const running = servers
      .filter((x) => x.desired_status === "running" && !x.suspended)
      .map((x) => x.id);
    s = (
      await c.query(
        `INSERT INTO account_suspensions(user_id,reference,reason,source,message,internal_note,stop_servers,stopped_server_ids,allow_backup_download,allow_account_deletion,lift_on_payment,notify,until,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          userId,
          `MWS-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(1).toString("hex").toUpperCase()}`,
          input.reason,
          input.source || "admin",
          message,
          internal,
          input.stopServers ?? (await suspensionSettings()).defaultServers,
          running,
          input.allowBackupDownload === true,
          input.allowAccountDeletion !== false,
          input.reason === "billing" && input.liftOnPayment !== false,
          input.notify !== false,
          input.until || null,
          actor,
        ],
      )
    ).rows[0];
    await c.query("UPDATE users SET status='suspended' WHERE id=$1", [userId]);
    await c.query("DELETE FROM sftp_tokens WHERE user_id=$1", [userId]);
    if (s.stop_servers)
      for (const server of servers) {
        await c.query(
          "UPDATE servers SET suspended=true,suspended_reason=COALESCE(suspended_reason,'account'),desired_status='stopped' WHERE id=$1",
          [server.id],
        );
        // Cancel unclaimed starts; the agent's claim guard handles concurrent start jobs.
        await c.query(
          "UPDATE jobs SET state='failed',error='Account suspended',finished_at=now() WHERE server_id=$1 AND kind IN ('start','restart') AND state='queued'",
          [server.id],
        );
        await c.query(
          "INSERT INTO jobs(node_id,server_id,kind) VALUES($1,$2,'stop')",
          [server.node_id, server.id],
        );
      }
    await c.query(
      "INSERT INTO account_suspension_events(suspension_id,kind,actor,data) VALUES($1,'created',$2,$3)",
      [
        s.id,
        actor,
        JSON.stringify({
          reference: s.reference,
          reason: s.reason,
          message: s.message,
          internalNote: s.internal_note,
          stopServers: s.stop_servers,
          until: s.until,
        }),
      ],
    );
    if (s.stop_servers)
      await c.query(
        "INSERT INTO account_suspension_events(suspension_id,kind,actor,data) VALUES($1,'servers_stop_requested',$2,$3)",
        [s.id, actor, JSON.stringify({ ids: servers.map((x) => x.id) })],
      );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  await audit(actor, "customer.suspend", "user", userId, {
    reference: s.reference,
  });
  await emit({kind:"suspension.created",title:"Your account has been paused",body:s.message,recipientIds:[userId],data:{reference:s.reference},dedupe:{key:"suspend:"+s.id,minutes:1440}});
  if (s.notify) await mail(s);
  return suspensionShape(s);
}
export async function liftAccount(
  userId: string,
  actor: string | null,
  note = "",
  automatic = false,
  paymentOnly = false,
) {
  const c = await pool.connect();
  let s: any;
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "suspension:" + userId,
    ]);
    s = (
      await c.query(
        "SELECT * FROM account_suspensions WHERE user_id=$1 AND lifted_at IS NULL FOR UPDATE",
        [userId],
      )
    ).rows[0];
    if (!s) {
      await c.query("COMMIT");
      return { ok: true };
    }
    if (
      paymentOnly &&
      (!s.lift_on_payment ||
        (
          await c.query(
            "SELECT 1 FROM invoices WHERE user_id=$1 AND status='open' AND amount_due>amount_paid UNION ALL SELECT 1 FROM subscriptions WHERE user_id=$1 AND status IN ('past_due','suspended') LIMIT 1",
            [userId],
          )
        ).rowCount)
    ) {
      await c.query("COMMIT");
      return { ok: true };
    }
    const servers = (
      await c.query(
        "SELECT s.*,sub.status AS billing_status,sub.holds AS billing_holds FROM servers s LEFT JOIN subscriptions sub ON sub.id=s.subscription_id WHERE s.owner_id=$1 AND s.deleted_at IS NULL FOR UPDATE OF s",
        [userId],
      )
    ).rows;
    for (const server of servers) {
      if (server.suspended_reason !== "account") continue;
      const billing =
        ["suspended", "terminated"].includes(server.billing_status) ||
        (server.billing_holds?.length || 0) > 0;
      if (billing) {
        await c.query(
          "UPDATE servers SET suspended_reason='billing',suspended=true WHERE id=$1",
          [server.id],
        );
        continue;
      }
      const restart = s.stopped_server_ids.includes(server.id);
      await c.query(
        "UPDATE servers SET suspended=false,suspended_reason=NULL,pending_delete_at=NULL,desired_status=CASE WHEN $2 THEN 'running' ELSE desired_status END WHERE id=$1",
        [server.id, restart],
      );
      // Resume provisioning or configuration that was refused at the agent's hold guard.
      for (const pending of (
        await c.query(
          "SELECT DISTINCT ON(kind) kind,payload FROM jobs WHERE server_id=$1 AND kind IN ('create','configure') AND state='failed' AND error='Server is on hold' ORDER BY kind,created_at DESC",
          [server.id],
        )
      ).rows) {
        await c.query(
          "INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,$3,$4)",
          [
            server.node_id,
            server.id,
            pending.kind,
            JSON.stringify(pending.payload),
          ],
        );
        await c.query(
          "UPDATE jobs SET error='Account hold lifted; operation requeued' WHERE server_id=$1 AND kind=$2 AND error='Server is on hold'",
          [server.id, pending.kind],
        );
      }
      if (restart)
        await c.query(
          "INSERT INTO jobs(node_id,server_id,kind) VALUES($1,$2,'start')",
          [server.node_id, server.id],
        );
    }
    await c.query(
      "INSERT INTO account_suspension_events(suspension_id,kind,actor,data) VALUES($1,'servers_restored',$2,$3)",
      [
        s.id,
        actor,
        JSON.stringify({
          ids: servers
            .filter(
              (x) =>
                x.suspended_reason === "account" &&
                !["suspended", "terminated"].includes(x.billing_status) &&
                !x.billing_holds?.length,
            )
            .map((x) => x.id),
        }),
      ],
    );
    s = (
      await c.query(
        "UPDATE account_suspensions SET lifted_at=now(),lifted_by=$2,lift_note=$3 WHERE id=$1 RETURNING *",
        [s.id, actor, note.slice(0, 2000)],
      )
    ).rows[0];
    await c.query(
      "UPDATE users SET status='active' WHERE id=$1 AND status='suspended'",
      [userId],
    );
    await c.query(
      "INSERT INTO account_suspension_events(suspension_id,kind,actor,data) VALUES($1,$2,$3,$4)",
      [
        s.id,
        automatic ? "auto_lifted" : "lifted",
        actor,
        JSON.stringify({ note }),
      ],
    );
    await c.query(
      "UPDATE subscriptions SET next_fulfilment_at=now() WHERE user_id=$1 AND fulfilment='pending'",
      [userId],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  await audit(actor, "customer.unsuspend", "user", userId, {
    reference: s.reference,
  });
  await emit({kind:"suspension.lifted",title:"Your account is available again",recipientIds:[userId],data:{reference:s.reference},dedupe:{key:"lift:"+s.id,minutes:1440}});
  if((await pool.query("SELECT 1 FROM account_suspension_events WHERE suspension_id=$1 AND kind='retention_termination'",[s.id])).rowCount)await emit({kind:"suspension.retention_cancelled",title:"Suspension termination cancelled",data:{reference:s.reference},dedupe:{key:"cancel-terminate:"+s.id,minutes:1440}});
  await mail(s, true);
  return { ok: true };
}
export async function sweepSuspensions() {
  for (const s of (
    await pool.query(
      "SELECT user_id FROM account_suspensions WHERE lifted_at IS NULL AND until<=now() LIMIT 50",
    )
  ).rows)
    await liftAccount(s.user_id, null, "Scheduled lift", true);
  const cfg = await suspensionSettings();
  if (!cfg.retentionDays) return;
  for (const s of (
    await pool.query(
      "SELECT * FROM account_suspensions WHERE lifted_at IS NULL AND retention_notified_at IS NULL AND created_at<now()-make_interval(days=>$1) LIMIT 50",
      [cfg.retentionDays],
    )
  ).rows) {
    await emit({
      kind: "suspension.retention",
      title: "Suspension reached retention date",
      body: s.reference,
      severity: "warn",
      dedupe: { key: "retention:" + s.id, minutes: 1440 },
    });
    if (cfg.autoTerminate) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "suspension:" + s.user_id,
        ]);
        const stillOpen = await c.query(
          "SELECT id FROM account_suspensions WHERE id=$1 AND lifted_at IS NULL FOR UPDATE",
          [s.id],
        );
        if (!stillOpen.rowCount) {
          await c.query("COMMIT");
          continue;
        }
        await c.query(
          "UPDATE servers SET suspended=true,desired_status='stopped',suspended_reason='account',pending_delete_at=now()+interval '2 hours' WHERE owner_id=$1 AND deleted_at IS NULL AND (suspended_reason='account' OR suspended_reason IS NULL)",
          [s.user_id],
        );
        await c.query(
          "INSERT INTO account_suspension_events(suspension_id,kind,data) VALUES($1,'retention_termination',$2)",
          [s.id, JSON.stringify({ deletesAfterHours: 2 })],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
      await emit({kind:"suspension.retention_scheduled",title:"Suspended account termination scheduled",data:{reference:s.reference},dedupe:{key:"terminate:"+s.id,minutes:1440}});
      await audit(null, "suspension.retention.terminate", "user", s.user_id, {
        reference: s.reference,
      });
    }
    await pool.query(
      "UPDATE account_suspensions SET retention_notified_at=now() WHERE id=$1",
      [s.id],
    );
  }
}
export function suspensionRoutes(app: FastifyInstance) {
  app.get("/api/support/suspension-settings", async (req) => {
    can(req, "customers.suspend");
    return suspensionSettings();
  });
  app.put("/api/support/suspension-settings", async (req) => {
    can(req, "customers.suspend");
    const b = req.body as any,
      out = { ...defaultSuspension };
    for (const [k, v] of Object.entries(b || {})) {
      if (!(k in out)) fail(400, "Unknown suspension setting");
      if (typeof (out as any)[k] === "boolean") {
        if (typeof v !== "boolean") fail(400, "Expected boolean");
      } else if (
        !Number.isInteger(v) ||
        Number(v) < (k === "retentionDays" ? 0 : 1) ||
        Number(v) > 3650
      )
        fail(400, "Invalid suspension limit");
      (out as any)[k] = v;
    }
    if (out.autoTerminate && !out.retentionDays)
      fail(400, "Set a retention period before enabling termination");
    await pool.query(
      "INSERT INTO settings(key,value) VALUES('suspension',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [JSON.stringify(out)],
    );
    await audit(
      req.actor!.id,
      "suspension.settings",
      "settings",
      "suspension",
      out,
    );
    return out;
  });
  app.post("/api/customers/:id/suspension/reply", async (req) => {
    can(req, "customers.suspend");
    const userId = asId((req.params as any).id),
      t = (
        await pool.query(
          "SELECT t.*,s.reference FROM support_tickets t JOIN account_suspensions s ON s.id=t.suspension_id WHERE s.user_id=$1 AND s.lifted_at IS NULL",
          [userId],
        )
      ).rows[0];
    if (!t) fail(404, "No appeal has been opened");
    if (["solved", "closed"].includes(t.status))
      fail(409, "Reopen the appeal ticket first");
    const body = txt((req.body as any)?.body, 2000);
    await pool.query(
      "INSERT INTO support_messages(ticket_id,author_user_id,author_kind,body) VALUES($1,$2,'agent',$3)",
      [t.id, req.actor!.id, body],
    );
    await pool.query(
      "UPDATE support_tickets SET updated_at=now(),last_agent_activity_at=now(),first_reply_at=COALESCE(first_reply_at,now()) WHERE id=$1",
      [t.id],
    );
    await pool.query(
      "INSERT INTO account_suspension_events(suspension_id,kind,actor,data) VALUES($1,'reply',$2,$3)",
      [t.suspension_id, req.actor!.id, JSON.stringify({ ticketId: t.id })],
    );
    await sendTemplate(
      "suspension_reply",
      t.requester_email,
      { reference: t.reference, message: body, link: WEB_ORIGIN },
      { userId },
    );
    await audit(req.actor!.id, "suspension.reply", "user", userId, {
      reference: t.reference,
    });
    return { ok: true };
  });
  app.post("/api/customers/:id/suspend", async (req) => {
    can(req, "customers.suspend");
    return suspendAccount(
      asId((req.params as any).id),
      req.actor!.id,
      req.body as SuspensionOptions,
    );
  });
  app.get("/api/customers/:id/suspension", async (req) => {
    can(req, "customers.view");
    const s = (
      await pool.query(
        "SELECT s.*,u.display_name FROM account_suspensions s LEFT JOIN users u ON u.id=s.created_by WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 1",
        [asId((req.params as any).id)],
      )
    ).rows[0];
    if (!s) return null;
    return {
      ...suspensionShape(s),
      internalNote: s.internal_note,
      notify: s.notify,
      events: (
        await pool.query(
          "SELECT e.*,s.reference FROM account_suspension_events e JOIN account_suspensions s ON s.id=e.suspension_id WHERE s.user_id=$1 ORDER BY e.id",
          [s.user_id],
        )
      ).rows,
      ticketId:
        (
          await pool.query(
            "SELECT id FROM support_tickets WHERE suspension_id=$1",
            [s.id],
          )
        ).rows[0]?.id || null,
    };
  });
  app.delete("/api/customers/:id/suspension", async (req) => {
    can(req, "customers.suspend");
    return liftAccount(
      asId((req.params as any).id),
      req.actor!.id,
      String((req.body as any)?.note || ""),
    );
  });
  app.patch("/api/customers/:id/suspension", async (req) => {
    can(req, "customers.suspend");
    const b = req.body as any;
    if (
      !b ||
      Object.keys(b).some(
        (k) =>
          ![
            "message",
            "internalNote",
            "until",
            "allowBackupDownload",
            "allowAccountDeletion",
            "liftOnPayment",
          ].includes(k),
      )
    )
      fail(400, "Unsupported suspension edit");
    if (
      b.until &&
      (!Number.isFinite(Date.parse(b.until)) ||
        Date.parse(b.until) <= Date.now())
    )
      fail(400, "Lift date must be in the future");
    for (const k of [
      "allowBackupDownload",
      "allowAccountDeletion",
      "liftOnPayment",
    ])
      if (b[k] !== undefined && typeof b[k] !== "boolean")
        fail(400, "Expected boolean");
    const id = asId((req.params as any).id);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "suspension:" + id,
      ]);
      const s = (
        await c.query(
          "UPDATE account_suspensions SET message=COALESCE($2,message),internal_note=COALESCE($3,internal_note),until=CASE WHEN $4 THEN $5::timestamptz ELSE until END,allow_backup_download=COALESCE($6,allow_backup_download),allow_account_deletion=COALESCE($7,allow_account_deletion),lift_on_payment=COALESCE($8,lift_on_payment) WHERE user_id=$1 AND lifted_at IS NULL RETURNING *",
          [
            id,
            b.message === undefined ? null : txt(b.message, 2000),
            b.internalNote === undefined
              ? null
              : String(b.internalNote).slice(0, 2000),
            b.until !== undefined,
            b.until || null,
            b.allowBackupDownload ?? null,
            b.allowAccountDeletion ?? null,
            b.liftOnPayment ?? null,
          ],
        )
      ).rows[0];
      if (!s) fail(404, "Suspension not found");
      await c.query(
        "INSERT INTO account_suspension_events(suspension_id,kind,actor,data) VALUES($1,'updated',$2,$3)",
        [s.id, req.actor!.id, JSON.stringify(b)],
      );
      await c.query("COMMIT");
      await emit({kind:"suspension.updated",title:"Your account suspension has been updated",recipientIds:[id],data:{reference:s.reference}});
      await audit(req.actor!.id, "customer.suspension.update", "user", id, {
        reference: s.reference,
      });
      return suspensionShape(s);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  });
  app.get("/api/suspension", async (req) => {
    const s = (
      await pool.query(
        "SELECT s.*,u.display_name FROM account_suspensions s LEFT JOIN users u ON u.id=s.created_by WHERE s.user_id=$1 AND s.lifted_at IS NULL",
        [req.actor!.id],
      )
    ).rows[0];
    if (!s) fail(404, "No active suspension");
    const cfg = await suspensionSettings();
    const ticket = (
      await pool.query(
        "SELECT id FROM support_tickets WHERE suspension_id=$1",
        [s.id],
      )
    ).rows[0];
    return {
      ...suspensionShape(s),
      retentionDays: cfg.retentionDays,
      appealsEnabled: cfg.appealsEnabled,
      ticketId: ticket?.id || null,
    };
  });
}
