// Run with: npx tsx --test src/lib/markdown.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, parseMarkdown, plainText, safeHref } from "./markdown";

test("safeHref allows only https", () => {
  assert.equal(safeHref("https://modrinth.com/mod/x"), "https://modrinth.com/mod/x");
  assert.equal(safeHref("http://example.com"), null);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("  JAVASCRIPT:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<b>x</b>"), null);
  assert.equal(safeHref("//evil.example"), null);
  assert.equal(safeHref("https://"), null);
});

test("headings, paragraphs and rules", () => {
  const blocks = parseMarkdown("# Title\n\nOne line\nsecond line\n\n---\n\n### Sub ###");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "rule", "heading"]);
  assert.equal(plainText([blocks[1]]), "One line second line");
  assert.equal(plainText([blocks[3]]), "Sub");
});

test("inline emphasis, code and links", () => {
  const nodes = parseInline("A **bold** and *it* with `code` and [site](https://example.com/a)");
  assert.deepEqual(nodes.map((n) => n.type), ["text", "strong", "text", "em", "text", "code", "text", "link"]);
  const link = nodes[7];
  assert.ok(link.type === "link" && link.href === "https://example.com/a");
});

test("unsafe links lose their href but keep their text", () => {
  for (const bad of ["javascript:alert(1)", "http://example.com", "data:text/html,x", "vbscript:x"]) {
    const nodes = parseInline(`[click](${bad})`);
    assert.ok(nodes.every((n) => n.type !== "link"), bad);
    assert.equal(plainText([{ type: "paragraph", children: nodes }]), "click");
  }
});

test("images are dropped", () => {
  const nodes = parseInline("before ![badge](https://img.shields.io/x.svg) after");
  assert.equal(plainText([{ type: "paragraph", children: nodes }]), "before  after");
});

test("raw HTML never becomes markup", () => {
  const blocks = parseMarkdown('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n<p align="center">Hello</p>');
  const text = plainText(blocks);
  assert.ok(!text.includes("<img"));
  assert.ok(!text.includes("<p"));
  assert.ok(text.includes("Hello"));
  assert.ok(JSON.stringify(blocks).indexOf('"type":"html"') === -1);
});

test("fenced code keeps its content verbatim", () => {
  const [block] = parseMarkdown("```yaml\nkey: **not bold**\n<b>x</b>\n```");
  assert.ok(block.type === "code");
  assert.equal(block.lang, "yaml");
  assert.equal(block.text, "key: **not bold**\n<b>x</b>");
});

test("an unterminated fence swallows the rest as code", () => {
  const [block] = parseMarkdown("```\nabc\ndef");
  assert.ok(block.type === "code" && block.text === "abc\ndef");
});

test("lists, ordered lists and nesting", () => {
  const [ul, ol] = parseMarkdown("- one\n- two\n  - nested\n- three\n\n1. a\n2. b");
  assert.ok(ul.type === "list" && !ul.ordered && ul.items.length === 3);
  assert.ok(ul.type === "list" && ul.items[1].nested.length === 1);
  assert.ok(ol.type === "list" && ol.ordered && ol.items.length === 2);
});

test("blockquotes contain blocks", () => {
  const [q] = parseMarkdown("> quoted **text**\n> more");
  assert.ok(q.type === "quote" && q.children[0].type === "paragraph");
});

test("snake_case and lone asterisks are not emphasis", () => {
  const nodes = parseInline("use my_cool_mod with 2 * 3 * 4");
  assert.ok(nodes.every((n) => n.type === "text"));
});

test("pathological input stays fast and bounded", () => {
  const started = Date.now();
  parseMarkdown("*".repeat(50_000));
  parseMarkdown("[".repeat(20_000) + "](https://x)");
  parseMarkdown("> ".repeat(5_000) + "deep");
  parseMarkdown("- a\n".repeat(5_000));
  assert.ok(Date.now() - started < 3000, "parsing took too long");
});

test("non-string input does not throw", () => {
  assert.deepEqual(parseMarkdown(undefined as unknown as string), []);
  assert.deepEqual(parseMarkdown(""), []);
});
