// Run with: npx tsx --test src/lib/useragent.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceLabel, isMobileAgent } from "./useragent";

test("recognises common browsers and systems", () => {
  assert.equal(
    deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Chrome on Windows",
  );
  assert.equal(
    deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"),
    "Edge on Windows",
  );
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"), "Safari on macOS");
  assert.equal(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0"), "Firefox on Linux");
  assert.equal(
    deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1"),
    "Chrome on iOS",
  );
  assert.equal(
    deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"),
    "Chrome on Android",
  );
});

test("falls back gracefully", () => {
  assert.equal(deviceLabel(""), "Unknown device");
  assert.equal(deviceLabel(null), "Unknown device");
  assert.equal(deviceLabel("curl/8.4.0"), "curl");
  assert.equal(deviceLabel("something odd"), "Unknown device");
});

test("detects mobile agents", () => {
  assert.equal(isMobileAgent("Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36"), true);
  assert.equal(isMobileAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/126"), false);
});
