import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PERMISSIONS,
  PRESETS,
  routePermission,
  validPermissions,
} from "../src/permissions.js";
import { suspensionAllows } from "../src/suspension-policy.js";
import {
  customerTicket,
  detectAttachment,
  redactDiagnostics,
} from "../src/support-policy.js";
import {
  addBusinessMinutes,
  businessMinutesBetween,
  validateHours,
} from "../src/support-clock.js";
import { readFileSync } from "node:fs";
const id = "12345678-1234-1234-1234-123456789abc";
test("presets contain known unique grants; team management is exclusive", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.equal(new Set(p).size, p.length);
    assert(p.every((x) => ALL_PERMISSIONS.includes(x)));
    assert.equal(p.includes("team.manage"), name === "Super admin");
  }
  assert(!validPermissions(["team.manage"]));
  assert(!validPermissions(["servers.view", "servers.view"]));
});
test("suspension defaults deny method confusion, encoded paths and unrelated tickets", () => {
  assert(suspensionAllows("GET", "/api/auth/me"));
  for (const [m, p] of [
    ["POST", "/api/servers"],
    ["GET", `/api/servers/${id}`],
    ["GET", "/api/%61uth/me"],
    ["GET", "/api/auth/../auth/me"],
    ["POST", "/api/account/delete"],
  ])
    assert(!suspensionAllows(m, p));
  assert(
    suspensionAllows("POST", "/api/account/delete", { allowDeletion: true }),
  );
  assert(
    suspensionAllows("GET", `/api/support/tickets/${id}`, { ticketId: id }),
  );
  assert(
    !suspensionAllows("GET", `/api/support/tickets/${id}/attachments/x`, {
      ticketId: id,
    }),
  );
});
test("documented administrative routes declare a policy", () => {
  const src = readFileSync(
    new URL("../src/openapi.ts", import.meta.url),
    "utf8",
  );
  for (const m of src.matchAll(
    /'((?:GET|POST|PUT|PATCH|DELETE)) ([^']+)':D\([^\n]*?'admin'/g,
  ))
    assert(routePermission(m[1], m[2]), m[0]);
});
test("customer projections exclude private fields", () => {
  const t = customerTicket({
    id,
    number: 42,
    subject: "Help",
    internal_note: "secret",
    diagnostics: { token: "secret" },
    tags: ["private"],
    assignee_id: id,
    first_reply_due_at: new Date(),
  });
  for (const k of [
    "internal_note",
    "tags",
    "diagnostics",
    "assignee_id",
    "first_reply_due_at",
  ])
    assert(!(k in t));
});
test("attachments reject active documents, oversize files and false types", () => {
  assert.equal(detectAttachment(Buffer.from("<svg></svg>"), "file.txt"), null);
  assert.equal(
    detectAttachment(Buffer.from("<html>bad</html>"), "file.log"),
    null,
  );
  assert.equal(
    detectAttachment(Buffer.from("plain log"), "file.log"),
    "text/plain",
  );
  assert.equal(
    detectAttachment(Buffer.from("{}"), "data.json"),
    "application/json",
  );
  assert.equal(detectAttachment(Buffer.alloc(5242881), "log.txt"), null);
});
test("diagnostics exclude credentials", () => {
  const d = redactDiagnostics({
    name: "s",
    variables: { TOKEN: "secret" },
    usage: { password: "secret" },
    crash_state: { token: "secret", exitCode: 137 },
  });
  assert(!JSON.stringify(d).includes("secret"));
  assert.equal(d.crash.exitCode, 137);
});
const h = validateHours({
  timezone: "Europe/Berlin",
  weekly: {
    1: [[540, 1020]],
    2: [[540, 1020]],
    3: [[540, 1020]],
    4: [[540, 1020]],
    5: [[540, 1020]],
  },
  holidays: ["2026-04-06"],
});
test("business clock handles evenings, weekends, holidays and DST", () => {
  assert.equal(
    addBusinessMinutes(new Date("2026-03-27T15:30:00Z"), 60, h).toISOString(),
    "2026-03-30T07:30:00.000Z",
  );
  assert.equal(
    addBusinessMinutes(new Date("2026-04-03T14:30:00Z"), 60, h).toISOString(),
    "2026-04-07T07:30:00.000Z",
  );
  assert.equal(
    businessMinutesBetween(
      new Date("2026-03-27T15:30:00Z"),
      new Date("2026-03-30T07:30:00Z"),
      h,
    ),
    60,
  );
});

test("business clock preserves half-hour DST folds and quarter-hour offsets", () => {
  const h = {
    timezone: "Australia/Lord_Howe",
    weekly: { "0": [[90, 150]] as [number, number][] },
    holidays: [],
  };
  assert.equal(
    addBusinessMinutes(new Date("2026-04-04T14:30:00Z"), 90, h).toISOString(),
    "2026-04-04T16:00:00.000Z",
  );
  assert.equal(
    businessMinutesBetween(
      new Date("2026-04-04T14:30:00Z"),
      new Date("2026-04-04T16:00:00Z"),
      h,
    ),
    90,
  );
  const q = {
    timezone: "Asia/Kathmandu",
    weekly: { "1": [[540, 600]] as [number, number][] },
    holidays: [],
  };
  assert.equal(
    addBusinessMinutes(new Date("2026-04-06T03:15:00Z"), 60, q).toISOString(),
    "2026-04-06T04:15:00.000Z",
  );
});
