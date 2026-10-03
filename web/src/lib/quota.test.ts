// Run with: npx tsx --test src/lib/quota.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { formToQuota, hasQuota, quotaShare, quotaToForm } from "./quota";

test("converts friendly units to API units", () => {
  const q = formToQuota({ servers: "5", memoryGb: "8", cpuCores: "2.5", diskGb: "50", backups: "", extraPorts: "0" });
  assert.deepEqual(q, { maxServers: 5, maxMemoryMb: 8192, maxCpuPercent: 250, maxDiskMb: 51200, maxExtraPorts: 0 });
});

test("empty means unlimited", () => {
  assert.equal(formToQuota({ servers: "", memoryGb: " ", cpuCores: "", diskGb: "", backups: "", extraPorts: "" }), null);
});

test("rejects bad input", () => {
  assert.throws(() => formToQuota({ servers: "1.5", memoryGb: "", cpuCores: "", diskGb: "", backups: "", extraPorts: "" }), /whole number/);
  assert.throws(() => formToQuota({ servers: "-1", memoryGb: "", cpuCores: "", diskGb: "", backups: "", extraPorts: "" }), /0 or more/);
  assert.throws(() => formToQuota({ servers: "", memoryGb: "abc", cpuCores: "", diskGb: "", backups: "", extraPorts: "" }), /number/);
});

test("round trips", () => {
  const q = { maxServers: 3, maxMemoryMb: 1536, maxCpuPercent: 150, maxDiskMb: 20480 };
  assert.deepEqual(formToQuota(quotaToForm(q)), q);
  assert.equal(hasQuota({}), false);
  assert.equal(hasQuota(q), true);
});

test("share of a limit", () => {
  assert.equal(quotaShare(2, 4), 50);
  assert.equal(quotaShare(2, undefined), null);
  assert.equal(quotaShare(1, 0), 100);
});
