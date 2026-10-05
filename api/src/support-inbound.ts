import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { pool, fail, txt, hash } from "./core.js";
import { supportRate, supportSettings } from "./support-policy.js";
import { emit } from "./notifications.js";
const key = () => process.env.SUPPORT_INBOUND_SECRET || "";
export const inboundEnabled = () => key().length >= 32;
export const replyToken = (id: string, email: string) =>
  createHmac("sha256", key())
    .update(`ticket:${id}:${email.toLowerCase()}`)
    .digest("hex");
function same(a: unknown, b: string) {
  return (
    typeof a === "string" &&
    /^[a-f0-9]{64}$/.test(a) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  );
}
export function trimEmailReply(text: string) {
  return text
    .split(/\n(?:On .{1,300}wrote:|_{5,}|-{5,}\s*Original Message|>)/i)[0]
    .trim()
    .slice(0, 20000);
}
/** An opt-in adapter endpoint. The inbox bridge signs the exact timestamp + JSON payload. */
export function supportInbound(
  app: FastifyInstance,
  callbacks: {
    runRules: (id: string, trigger: string) => Promise<void>;
    changeStatus: (
      ticket: any,
      status: string,
      actor: string | null,
    ) => Promise<void>;
  },
) {
  app.post("/api/support/inbound", async (req) => {
    if (!inboundEnabled()) fail(404, "Inbound support email is disabled");
    const stamp = String(req.headers["x-support-timestamp"] || ""),
      sig = req.headers["x-support-signature"];
    if (
      !/^\d{10}$/.test(stamp) ||
      Math.abs(Date.now() / 1000 - Number(stamp)) > 300
    )
      fail(401, "Expired inbound signature");
    const expected = createHmac("sha256", key())
      .update(stamp + "\n" + JSON.stringify(req.body))
      .digest("hex");
    if (!same(sig, expected)) fail(401, "Invalid inbound signature");
    await supportRate("inbound-global", 100, 60);
    const b = req.body as any,
      t = (
        await pool.query(
          "SELECT t.*,u.status AS user_status,u.disabled,EXISTS(SELECT 1 FROM account_suspensions a WHERE a.user_id=t.requester_user_id AND a.lifted_at IS NULL) AS account_held FROM support_tickets t LEFT JOIN users u ON u.id=t.requester_user_id WHERE t.id=$1",
          [txt(b?.ticketId, 36)],
        )
      ).rows[0];
    if (
      !t ||
      !same(b.replyToken, replyToken(t.id, t.requester_email)) ||
      String(b.from || "").toLowerCase() !== t.requester_email.toLowerCase()
    )
      fail(403, "Invalid ticket reply token");
    if (t.disabled || (t.account_held && !t.suspension_id))
      fail(403, "This account may only reply to its suspension appeal");
    if (!t.suspension_id && !(await supportSettings()).enabled)
      fail(403, "The help desk is disabled");
    if (["solved", "closed"].includes(t.status))
      fail(409, "Reopen the ticket in the panel before replying");
    const body = txt(
        trimEmailReply(txt(b.text, 50000)),
        t.suspension_id ? 2000 : 20000,
      ),
      messageId = hash(txt(b.messageId, 500));
    await supportRate("inbound:" + t.id, 10, 60);
    const c = await pool.connect();
    let duplicate = false;
    try {
      await c.query("BEGIN");
      await c.query("SELECT id FROM support_tickets WHERE id=$1 FOR UPDATE", [
        t.id,
      ]);
      const r = await c.query(
        "INSERT INTO support_inbound_messages(id,ticket_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id",
        [messageId, t.id],
      );
      duplicate = !r.rowCount;
      if (!duplicate) {
        await c.query(
          "INSERT INTO support_messages(ticket_id,author_user_id,author_kind,body,via) VALUES($1,$2,$3,$4,'email')",
          [
            t.id,
            t.requester_user_id,
            t.requester_user_id ? "customer" : "external",
            body,
          ],
        );
        await c.query(
          "UPDATE support_tickets SET updated_at=now(),last_customer_activity_at=now() WHERE id=$1",
          [t.id],
        );
        await c.query(
          "INSERT INTO support_events(ticket_id,kind,data) VALUES($1,'email_received',$2)",
          [t.id, JSON.stringify({ messageId })],
        );
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    if (!duplicate) {
      if (t.status === "pending")
        await callbacks.changeStatus(t, "open", t.requester_user_id);
      await callbacks.runRules(t.id, "customer_replied");
      await emit({
        kind: t.suspension_id?"suspension.appeal_replied":"support.customer_replied",
        recipientIds:[],
        title: `Email reply to #${t.number}`,
        data: { ticketId: t.id },
      });
    }
    return { ok: true, duplicate };
  });
}
