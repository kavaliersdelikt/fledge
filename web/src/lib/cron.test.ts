// Run with: npx tsx --test src/lib/cron.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCron, describeCron, describeInterval } from "./cron";

test("common patterns read as sentences", () => {
  assert.equal(describeCron("30 4 * * *", "Europe/Berlin"), "Every day at 04:30 Europe/Berlin");
  assert.equal(describeCron("0 4 * * 1-5", "UTC"), "Weekdays at 04:00 UTC");
  assert.equal(describeCron("15 6 * * 1", ""), "Every Monday at 06:15");
  assert.equal(describeCron("0 22 * * 1,4", "UTC"), "Every Monday and Thursday at 22:00 UTC");
  assert.equal(describeCron("0 */6 * * *"), "Every 6 hours");
  assert.equal(describeCron("*/10 * * * *"), "Every 10 minutes");
  assert.equal(describeCron("0 * * * *"), "Every hour");
  assert.equal(describeCron("0 3 1 * *", "UTC"), "On day 1 of every month at 03:00 UTC");
  assert.equal(describeCron("0 3 * * 0,6", "UTC"), "Weekends at 03:00 UTC");
});

test("unusual expressions fall back to the raw text", () => {
  assert.equal(describeCron("5 4 * 6 *", "UTC"), "5 4 * 6 *");
  assert.equal(describeCron("not cron"), "not cron");
  assert.equal(describeCron("0 4 * * 9", "UTC"), "0 4 * * 9");
});

test("presets build expressions that describe back", () => {
  assert.equal(buildCron("daily", { time: "04:30", every: 6, dow: 1 }), "30 4 * * *");
  assert.equal(buildCron("hours", { time: "00:00", every: 6, dow: 1 }), "0 */6 * * *");
  assert.equal(buildCron("weekdays", { time: "07:05", every: 6, dow: 1 }), "5 7 * * 1-5");
  assert.equal(buildCron("weekly", { time: "12:00", every: 6, dow: 0 }), "0 12 * * 0");
  assert.equal(describeCron(buildCron("weekly", { time: "12:00", every: 6, dow: 0 }), "UTC"), "Every Sunday at 12:00 UTC");
});

test("intervals", () => {
  assert.equal(describeInterval(30), "Every 30 minutes");
  assert.equal(describeInterval(120), "Every 2 hours");
  assert.equal(describeInterval(1440), "Every day");
});
