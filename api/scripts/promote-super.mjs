import { pool } from "../src/core.ts";
const email = process.argv[2];
if (!email) {
  console.error("Usage: node --import tsx scripts/promote-super.mjs <email>");
  process.exitCode = 1;
  await pool.end();
} else {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(539240193)");
    const u = (
      await c.query(
        "SELECT id FROM users WHERE email=$1 AND role='admin' AND NOT disabled AND status='active' FOR UPDATE",
        [email],
      )
    ).rows[0];
    if (!u)
      throw Error("An active administrator with that address was not found");
    const old = (
      await c.query("SELECT id FROM users WHERE is_super FOR UPDATE")
    ).rows[0];
    await c.query("UPDATE users SET is_super=false WHERE is_super");
    await c.query("UPDATE users SET is_super=true WHERE id=$1", [u.id]);
    await c.query(
      "INSERT INTO audit_events(action,target_type,target_id,detail) VALUES('team.recovery','user',$1,$2)",
      [u.id, JSON.stringify({ before: old?.id, after: u.id, source: "shell" })],
    );
    await c.query("COMMIT");
    console.log("Super administrator role transferred to " + email);
  } catch (e) {
    await c.query("ROLLBACK");
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}
