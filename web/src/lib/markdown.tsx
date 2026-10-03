import { createElement, type ReactNode } from "react";

/*
 * A tiny markdown renderer for text we don't control (plugin readmes, mod
 * descriptions, changelogs). It understands a small, safe subset and turns
 * everything else into plain text:
 *
 *   headings, paragraphs, **bold**, *italic*, `code`, fenced code, lists,
 *   blockquotes, rules and [links](https://…) (https only).
 *
 * No raw HTML (tags are dropped, never interpreted) and no images. The parser
 * is a pure function so it can be tested without React.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; text: string; lang: string }
  | { type: "list"; ordered: boolean; items: { children: Inline[]; nested: Block[] }[] }
  | { type: "quote"; children: Block[] }
  | { type: "rule" };

const MAX_SOURCE = 60_000;
const MAX_DEPTH = 4;

/** Only absolute https links are ever rendered as links. */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (!/^https:\/\//i.test(value) || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** Removes HTML tags and comments so they never show up as markup noise. */
function stripHtml(text: string) {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-zA-Z][^<>]{0,300}>/g, "");
}

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/** Index of the ")" closing the "(" at `open`, allowing balanced pairs, or -1. */
function findParen(src: string, open: number) {
  let depth = 0;
  const stop = Math.min(src.length, open + 2100);
  for (let i = open; i < stop; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** How far a span may reach; keeps pathological input linear. */
const WINDOW = 1500;

/** Index of the closing delimiter that is not escaped, or -1. */
function findClose(src: string, delim: string, from: number) {
  let i = from;
  const stop = Math.min(src.length, from + WINDOW);
  while (i < stop) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src.startsWith(delim, i)) return i;
    i++;
  }
  return -1;
}

export function parseInline(source: string, depth = 0): Inline[] {
  const src = stripHtml(source);
  const out: Inline[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(src[i + 1])) {
      pushText(out, src[i + 1]);
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(run, i + run.length);
      if (end > i) {
        out.push({ type: "code", text: src.slice(i + run.length, end).trim() });
        i = end + run.length;
        continue;
      }
      pushText(out, run);
      i += run.length;
      continue;
    }
    // Images are dropped entirely: ![alt](url)
    if (c === "!" && src[i + 1] === "[") {
      const close = findClose(src, "]", i + 2);
      if (close > 0 && src[close + 1] === "(") {
        const end = findParen(src, close + 1);
        if (end > 0) {
          i = end + 1;
          continue;
        }
      }
    }
    if (c === "[") {
      const close = findClose(src, "]", i + 1);
      if (close > 0 && src[close + 1] === "(") {
        const end = findParen(src, close + 1);
        if (end > 0) {
          const target = src.slice(close + 2, end).trim().split(/\s+/)[0] || "";
          const label = src.slice(i + 1, close);
          const href = safeHref(target.replace(/^<|>$/g, ""));
          const inner = depth < MAX_DEPTH ? parseInline(label, depth + 1) : [{ type: "text", text: label } as Inline];
          if (href && inner.length) out.push({ type: "link", href, children: inner });
          else for (const part of inner) out.push(part);
          i = end + 1;
          continue;
        }
      }
    }
    if (c === "<") {
      // Autolink: <https://example.com>
      const m = /^<(https:\/\/[^\s<>]+)>/.exec(src.slice(i, i + 2100));
      const href = m && safeHref(m[1]);
      if (m && href) {
        out.push({ type: "link", href, children: [{ type: "text", text: m[1] }] });
        i += m[0].length;
        continue;
      }
    }
    if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const strong = src.startsWith(c + c, i);
      const delim = strong ? c + c : c;
      const start = i + delim.length;
      // `_` inside a word (snake_case) is not emphasis.
      const wordy = c === "_" && i > 0 && /\w/.test(src[i - 1]);
      if (!wordy && start < src.length && !/\s/.test(src[start])) {
        const end = findClose(src, delim, start);
        if (end > start && !/\s/.test(src[end - 1]) && !(c === "_" && /\w/.test(src[end + delim.length] || ""))) {
          const children = parseInline(src.slice(start, end), depth + 1);
          out.push({ type: strong ? "strong" : "em", children });
          i = end + delim.length;
          continue;
        }
      }
    }
    pushText(out, c);
    i++;
  }
  return out;
}

const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const rule = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const bullet = /^(\s*)([-*+])\s+(.*)$/;
const numbered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

function startsBlock(line: string) {
  return fence.test(line) || heading.test(line) || rule.test(line) || /^\s{0,3}>/.test(line) || bullet.test(line) || numbered.test(line);
}

export function parseMarkdown(source: string, depth = 0): Block[] {
  const text = String(source ?? "").slice(0, MAX_SOURCE).replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const f = fence.exec(line);
    if (f) {
      const marker = f[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      blocks.push({ type: "code", text: body.join("\n"), lang: f[2] || "" });
      continue;
    }
    const h = heading.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length as 1, children: parseInline(h[2]) });
      i++;
      continue;
    }
    if (rule.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ type: "quote", children: depth < MAX_DEPTH ? parseMarkdown(inner.join("\n"), depth + 1) : [{ type: "paragraph", children: parseInline(inner.join(" ")) }] });
      continue;
    }
    const first = bullet.exec(line) || numbered.exec(line);
    if (first) {
      const ordered = !bullet.test(line);
      const base = first[1].length;
      const items: { children: Inline[]; nested: Block[] }[] = [];
      while (i < lines.length) {
        const m = (ordered ? numbered : bullet).exec(lines[i]);
        if (!m || m[1].length > base + 1) break;
        const body = [m[3]];
        const nested: string[] = [];
        i++;
        while (i < lines.length && lines[i].trim()) {
          const indent = /^\s*/.exec(lines[i])![0].length;
          if (indent > base + 1 && (bullet.test(lines[i]) || numbered.test(lines[i]))) nested.push(lines[i].slice(Math.min(indent, base + 2)));
          else if (indent > base && !nested.length && !startsBlock(lines[i])) body.push(lines[i].trim());
          else break;
          i++;
        }
        items.push({
          children: parseInline(body.join(" ")),
          nested: nested.length && depth < MAX_DEPTH ? parseMarkdown(nested.join("\n"), depth + 1) : [],
        });
        while (i < lines.length && !lines[i].trim() && (bullet.test(lines[i + 1] ?? "") || numbered.test(lines[i + 1] ?? ""))) i++;
      }
      if (items.length) {
        blocks.push({ type: "list", ordered, items });
        continue;
      }
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++].trim());
    if (!para.length) {
      i++;
      continue;
    }
    const children = parseInline(para.join(" "));
    if (children.length) blocks.push({ type: "paragraph", children });
  }
  return blocks;
}

/** Plain text of a document, used as the fallback and for tests. */
export function plainText(blocks: Block[]): string {
  const inline = (xs: Inline[]): string => xs.map((x) => (x.type === "text" || x.type === "code" ? x.text : inline(x.children))).join("");
  return blocks
    .map((b) =>
      b.type === "rule" ? "" : b.type === "code" ? b.text : b.type === "quote" ? plainText(b.children) : b.type === "list" ? b.items.map((it) => inline(it.children)).join("\n") : inline(b.children),
    )
    .join("\n\n");
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "code":
        return createElement("code", { key: i }, n.text);
      case "strong":
        return createElement("strong", { key: i }, renderInline(n.children));
      case "em":
        return createElement("em", { key: i }, renderInline(n.children));
      case "link":
        return createElement("a", { key: i, href: n.href, target: "_blank", rel: "noopener noreferrer nofollow ugc", referrerPolicy: "no-referrer" }, renderInline(n.children));
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "heading":
        // Descriptions bring their own h1; keep the page's hierarchy intact.
        return createElement(`h${Math.min(6, b.level + 2)}`, { key: i }, renderInline(b.children));
      case "paragraph":
        return createElement("p", { key: i }, renderInline(b.children));
      case "code":
        return createElement("pre", { key: i }, createElement("code", null, b.text));
      case "rule":
        return createElement("hr", { key: i });
      case "quote":
        return createElement("blockquote", { key: i }, renderBlocks(b.children));
      case "list":
        return createElement(
          b.ordered ? "ol" : "ul",
          { key: i },
          b.items.map((it, j) => createElement("li", { key: j }, renderInline(it.children), it.nested.length ? renderBlocks(it.nested) : null)),
        );
    }
  });
}

/** Renders untrusted markdown safely. Falls back to plain text if parsing ever throws. */
export function Markdown({ source, className = "" }: { source?: string | null; className?: string }) {
  let body: ReactNode;
  try {
    body = renderBlocks(parseMarkdown(source || ""));
  } catch {
    body = createElement("p", null, String(source || "").slice(0, MAX_SOURCE));
  }
  return createElement("div", { className: `md${className ? ` ${className}` : ""}` }, body);
}
