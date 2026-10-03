// Run with: npx tsx --test src/lib/css-tokens.test.ts
// The appearance settings (colours, text size, corner radius, density) only work if the stylesheets keep using tokens.
// This fails when someone adds a fixed font size, radius or colour, so theming cannot quietly rot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dir = join(import.meta.dirname, "..", "app");
const files = ["globals.css", "appearance.css", "commerce.css"];
const read = (f: string) => readFileSync(join(dir, f), "utf8").split("\r\n").join("\n");

/** Strips comments but keeps line numbers. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function offenders(file: string, test: (line: string, index: number) => boolean) {
  return code(read(file))
    .split("\n")
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l, n }) => test(l, n))
    .map(({ l, n }) => `${file}:${n}: ${l.trim()}`);
}

test("font sizes scale with the text size setting", () => {
  for (const f of files) {
    const bad = offenders(f, (l) => /font-size:\s*[0-9.]+px/.test(l));
    assert.deepEqual(bad, [], `Write font-size as calc(Npx * var(--text-scale)):\n${bad.join("\n")}`);
  }
});

test("corner radii scale with the radius setting", () => {
  for (const f of files) {
    const bad = offenders(f, (l) => {
      const m = /border(?:-[a-z]+)*-radius:\s*([^;]+);/.exec(l);
      if (!m) return false;
      const value = m[1].replace(/calc\([^)]*\)/g, "").replace(/var\([^)]*\)/g, "");
      // 0, percentages (circles) and large pill radii are not corners to scale.
      return [...value.matchAll(/([0-9.]+)px/g)].some((x) => Number(x[1]) > 0 && Number(x[1]) < 100);
    });
    assert.deepEqual(bad, [], `Write border-radius as calc(Npx * var(--radius-scale)):\n${bad.join("\n")}`);
  }
});

test("colours come from tokens", () => {
  for (const f of files) {
    const src = code(read(f));
    // The :root block defines the tokens themselves, so it may contain colours.
    const rootEnd = f === "globals.css" ? src.indexOf("\n}\n", src.indexOf(":root {")) : -1;
    const bad = offenders(f, (l, n) => {
      if (rootEnd > 0 && n <= src.slice(0, rootEnd).split("\n").length) return false;
      if (/--tw-ring-shadow:\s*0 0 #0000/.test(l)) return false; // Tailwind's "no ring"
      if (/mask-image:.*#000\b/.test(l)) return false; // a mask uses alpha only
      return /#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(?:rgba?|hsla?)\(/.test(l);
    });
    assert.deepEqual(bad, [], `Use a var(--token) or color-mix() of one instead of a fixed colour:\n${bad.join("\n")}`);
  }
});

test("control heights follow the density setting", () => {
  const css = read("globals.css");
  for (const selector of [".btn", ".input", ".nav__item", ".table td"]) {
    const block = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*\\}`, "m").exec(css)?.[0] || "";
    assert.match(block, /var\(--density\)/, `${selector} should use --density`);
  }
});
