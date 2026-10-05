import { freshDatabase, dbQuery } from "./harness.mjs";
import { execFileSync } from "node:child_process";
const databaseUrl = await freshDatabase("fledge_mews_upgrade");
const baseline = execFileSync("git", ["show", "HEAD:db/schema.sql"], {
  encoding: "utf8",
});
await dbQuery(databaseUrl, baseline);
const old = await dbQuery(
  databaseUrl,
  "INSERT INTO users(email,password_hash,role,created_at) VALUES('oldest@upgrade.test','unused','admin','2020-01-01'),('second@upgrade.test','unused','admin','2021-01-01'),('locked@upgrade.test','unused','customer','2022-01-01') RETURNING id,email",
);
await dbQuery(
  databaseUrl,
  "UPDATE users SET disabled=true WHERE role='customer'",
);
process.env.DATABASE_URL = databaseUrl;
const { migrate, pool } = await import("../src/core.ts");
try {
  await migrate();
  await migrate();
  const rows = (
    await pool.query(
      "SELECT email,is_super,disabled,role,status FROM users ORDER BY created_at",
    )
  ).rows;
  if (!rows[0].is_super || rows[1].is_super || !rows[2].disabled)
    throw Error("Upgrade did not preserve roles and hard locks");
  const second = rows[1];
  console.log(
    "Mews upgrade passed: oldest admin promoted, existing admin retained, hard lock preserved, migration rerunnable",
  );
} finally {
  await pool.end();
}
