import type { FastifyInstance } from "fastify";
import {
  pool,
  can,
  fail,
  txt,
  asId,
  audit,
  passwordHash,
  passwordCheck,
  token,
  hash,
  WEB_ORIGIN,
  looksLikeEmail,
  stepUp,
} from "./core.js";
import { PERMISSIONS, PRESETS, validPermissions } from "./permissions.js";
import { mailLink } from "./accounts.js";
import { sendTemplate } from "./email.js";
export function teamRoutes(app: FastifyInstance) {
  app.get("/api/permissions", async () => ({
    groups: PERMISSIONS,
    presets: PRESETS,
  }));
  app.get("/api/team", async (req) => {
    can(req, "team.manage");
    return (
      await pool.query(
        `SELECT u.id,u.email,u.display_name AS "displayName",u.is_super AS "isSuper",u.disabled,(u.totp_secret IS NOT NULL) AS "has2fa",u.admin_permissions AS permissions,u.created_at AS "createdAt",(SELECT max(last_seen_at) FROM sessions s WHERE s.user_id=u.id) AS "lastSignIn" FROM users u WHERE u.role='admin' ORDER BY u.is_super DESC,u.created_at`,
      )
    ).rows.map((u) => ({
      ...u,
      permissions: u.isSuper
        ? PRESETS["Super admin"]
        : (u.permissions ?? PRESETS.Administrator),
    }));
  });
  app.post("/api/team", async (req) => {
    can(req, "team.manage");
    await stepUp(req);
    const b = req.body as any,
      email = txt(b?.email, 254).toLowerCase();
    if (!looksLikeEmail(email)) fail(400, "Invalid email");
    const grants = b?.permissions ?? PRESETS[b?.preset || "Read-only"];
    if (!validPermissions(grants))
      fail(400, "Invalid administrator permissions");
    const c = await pool.connect();
    let user: any;
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "team:" + email,
      ]);
      user = (
        await c.query("SELECT * FROM users WHERE email=$1 FOR UPDATE", [email])
      ).rows[0];
      if (user) {
        if (user.role === "admin")
          fail(409, "That administrator already exists");
        if (user.status !== "active" || user.disabled)
          fail(409, "Only active customers can join the team");
        if (
          (
            await c.query(
              "SELECT 1 FROM servers WHERE owner_id=$1 UNION ALL SELECT 1 FROM subscriptions WHERE user_id=$1 UNION ALL SELECT 1 FROM orders WHERE user_id=$1 UNION ALL SELECT 1 FROM collaborators WHERE user_id=$1 LIMIT 1",
              [user.id],
            )
          ).rowCount
        )
          fail(
            409,
            "This account has customer data. Invite another email address.",
          );
        await c.query(
          "UPDATE users SET role='admin',admin_permissions=$2 WHERE id=$1",
          [user.id, grants],
        );
        await c.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
        await c.query("DELETE FROM api_tokens WHERE user_id=$1", [user.id]);
        await c.query("DELETE FROM sftp_tokens WHERE user_id=$1", [user.id]);
      } else
        user = (
          await c.query(
            "INSERT INTO users(email,password_hash,role,admin_permissions) VALUES($1,$2,'admin',$3) RETURNING id,email",
            [email, await passwordHash(token()), grants],
          )
        ).rows[0];
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    const invitation = await mailLink("invite", user, "7 days");
    await audit(req.actor!.id, "team.invite", "user", user.id, {
      permissions: grants,
    });
    return { id: user.id, email, ...invitation };
  });
  app.put("/api/team/:id/permissions", async (req) => {
    can(req, "team.manage");
    await stepUp(req);
    const id = asId((req.params as any).id),
      grants = (req.body as any)?.permissions;
    if (id === req.actor!.id) fail(403, "You cannot edit your own permissions");
    if (!validPermissions(grants)) fail(400, "Invalid permissions");
    const before = (
      await pool.query(
        "SELECT admin_permissions FROM users WHERE id=$1 AND role='admin' AND NOT is_super AND NOT disabled",
        [id],
      )
    ).rows[0];
    if (!before) fail(404, "Editable administrator not found");
    await pool.query(
      "UPDATE users SET admin_permissions=$2 WHERE id=$1 AND NOT is_super",
      [id, grants],
    );
    await audit(req.actor!.id, "team.permissions", "user", id, {
      before: before.admin_permissions ?? PRESETS.Administrator,
      after: grants,
    });
    return { ok: true };
  });
  app.delete("/api/team/:id", async (req) => {
    can(req, "team.manage");
    await stepUp(req);
    const id = asId((req.params as any).id),
      c = await pool.connect();
    try {
      await c.query("BEGIN");
      const u = (
        await c.query(
          "SELECT id,is_super FROM users WHERE id=$1 AND role='admin' FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!u) fail(404, "Administrator not found");
      if (u.is_super || id === req.actor!.id)
        fail(403, "The super administrator cannot be removed");
      await c.query(
        "UPDATE users SET disabled=true,admin_permissions=$2 WHERE id=$1",
        [id, []],
      );
      for (const table of [
        "sessions",
        "api_tokens",
        "sftp_tokens",
        "user_tokens",
      ])
        await c.query(`DELETE FROM ${table} WHERE user_id=$1`, [id]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    await audit(req.actor!.id, "team.remove", "user", id);
    return { ok: true };
  });
  app.post("/api/team/transfer", async (req) => {
    can(req, "team.manage");
    await stepUp(req);
    const b = req.body as any,
      id = asId(b?.receiverId);
    if (id === req.actor!.id) fail(400, "Choose another administrator");
    const sender = (
      await pool.query("SELECT password_hash FROM users WHERE id=$1", [
        req.actor!.id,
      ])
    ).rows[0];
    if (!(await passwordCheck(String(b?.password || ""), sender.password_hash)))
      fail(401, "Invalid password");
    const receiver = (
      await pool.query(
        "SELECT id,email FROM users WHERE id=$1 AND role='admin' AND NOT disabled AND totp_secret IS NOT NULL",
        [id],
      )
    ).rows[0];
    if (!receiver)
      fail(
        400,
        "Receiver must be an active administrator with two-factor authentication",
      );
    const raw = token();
    await pool.query("DELETE FROM team_transfers WHERE sender_id=$1", [
      req.actor!.id,
    ]);
    await pool.query(
      "INSERT INTO team_transfers(token_hash,sender_id,receiver_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [hash(raw), req.actor!.id, id],
    );
    const sent = await sendTemplate(
      "team_transfer",
      receiver.email,
      { link: `${WEB_ORIGIN}/team?transfer=${raw}` },
      { userId: id },
    );
    if (sent.status === "skipped") {
      await pool.query("DELETE FROM team_transfers WHERE token_hash=$1", [
        hash(raw),
      ]);
      fail(
        409,
        "Configure email delivery before transferring the super administrator role",
      );
    }
    await audit(req.actor!.id, "team.transfer.request", "user", id);
    return { ok: true };
  });
  // Confirmation is by the authenticated receiver, who cannot manage the team yet.
  app.post("/api/team/transfer/confirm", async (req) => {
    await stepUp(req);
    const c = await pool.connect();
    let sender: string;
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(539240193)");
      const t = (
        await c.query(
          "SELECT * FROM team_transfers WHERE token_hash=$1 AND receiver_id=$2 AND expires_at>now() FOR UPDATE",
          [hash(String((req.body as any)?.token || "")), req.actor!.id],
        )
      ).rows[0];
      if (!t) fail(400, "Transfer link expired or invalid");
      sender = t.sender_id;
      const users = (
        await c.query(
          "SELECT id,is_super,disabled,role FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [[sender, req.actor!.id]],
        )
      ).rows;
      if (
        !users.find((u) => u.id === sender && u.is_super) ||
        !users.find(
          (u) => u.id === req.actor!.id && !u.disabled && u.role === "admin",
        )
      )
        fail(409, "The team changed; request a new transfer");
      await c.query(
        "UPDATE users SET is_super=false,admin_permissions=$2 WHERE id=$1",
        [sender, PRESETS.Administrator],
      );
      await c.query("UPDATE users SET is_super=true WHERE id=$1", [
        req.actor!.id,
      ]);
      await c.query("DELETE FROM team_transfers");
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    await audit(req.actor!.id, "team.transfer", "user", req.actor!.id, {
      before: sender!,
      after: req.actor!.id,
    });
    return { ok: true };
  });
}
