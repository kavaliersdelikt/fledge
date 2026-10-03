// Checks that cannot be left to the site build: code blocks parse, screenshots exist and have alt text, the number of undocumented API
// operations has not grown. (Dead internal links are checked by `vitepress build`.)
//
//   node scripts/check.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, '..', 'docs');
const problems = [];

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return e.name === '.vitepress' || e.name === 'public' ? [] : walk(p);
  return e.name.endsWith('.md') ? [p] : [];
});
const files = walk(docs);
const hasShell = (() => { try { execFileSync('bash', ['-c', 'true']); return true; } catch { return false; } })();

let blocks = 0, shots = 0;
for (const file of files) {
  const rel = relative(docs, file);
  const generated = /^(api\/reference|releases|reference\/(environment|plugin-manifest|events|schema|jobs))/.test(rel.replace(/\\/g, '/'));
  const text = readFileSync(file, 'utf8').split('\r\n').join('\n');

  // Code blocks (not in generated release notes, which quote old commands).
  if (!generated) {
    for (const m of text.matchAll(/^```(\w+)[^\n]*\n([\s\S]*?)^```/gm)) {
      const [, lang, body] = m;
      const line = text.slice(0, m.index).split('\n').length;
      blocks++;
      if (lang === 'json' && !/[<…]|\.\.\./.test(body.replace(/"[^"\n]*"/g, '""'))) {
        try { JSON.parse(body); } catch (e) { problems.push(`${rel}:${line} invalid JSON: ${e.message}`); }
      }
      if ((lang === 'sh' || lang === 'bash') && hasShell && !/[<…]|\.\.\./.test(body)) {
        const dir = mkdtempSync(join(tmpdir(), 'docs-sh-'));
        const f = join(dir, 'block.sh');
        writeFileSync(f, body);
        try { execFileSync('bash', ['-n', f], { stdio: 'pipe' }); } catch (e) { problems.push(`${rel}:${line} shell syntax: ${String(e.stderr).trim().split('\n')[0]}`); }
      }
    }
  }

  // Screenshots: present, with alt text.
  for (const m of text.matchAll(/!\[([^\]]*)\]\((\/screenshots\/[^)\s]+)\)/g)) {
    shots++;
    const line = text.slice(0, m.index).split('\n').length;
    if (!m[1].trim()) problems.push(`${rel}:${line} screenshot without alt text`);
    if (!existsSync(join(docs, 'public', m[2]))) problems.push(`${rel}:${line} missing screenshot ${m[2]} (run npm run screenshots)`);
  }
  // Pages need a title.
  if (!generated && !/^---\n[\s\S]*?\btitle:/.test(text)) problems.push(`${rel}: no front matter title`);
}

// The count of operations without documentation may only go down.
const coverageFile = join(here, '..', 'generated', 'coverage.json');
const baselineFile = join(here, 'coverage-baseline.json');
if (existsSync(coverageFile) && existsSync(baselineFile)) {
  const { undocumented } = JSON.parse(readFileSync(coverageFile, 'utf8'));
  const { undocumented: allowed } = JSON.parse(readFileSync(baselineFile, 'utf8'));
  if (undocumented > allowed) problems.push(`${undocumented} API operations are undocumented, the baseline allows ${allowed}: add entries to api/src/openapi.ts`);
  if (undocumented < allowed) console.log(`Coverage improved: ${undocumented} undocumented (baseline ${allowed}); lower scripts/coverage-baseline.json.`);
}

if (problems.length) {
  console.error(`Docs checks failed:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`Docs checks passed: ${files.length} pages, ${blocks} code blocks, ${shots} screenshot references.`);
