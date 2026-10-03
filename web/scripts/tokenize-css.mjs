// One-time codemod used for 0.6.2.1 "Plumage": turns hard-coded sizes and colours in globals.css into tokens so the
// appearance settings can change them. Kept in the repository as documentation of how the conversion was done; running it
// again on an already converted file changes nothing.
//
//   node web/scripts/tokenize-css.mjs [path-to-globals.css]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'globals.css');
let css = readFileSync(file, 'utf8');
const eol = css.includes('\r\n') ? '\r\n' : '\n';
css = css.split('\r\n').join('\n');
const stats = { fontSize: 0, radius: 0, colour: 0 };

const num = (n) => String(Number(Number(n).toFixed(4)));

// 1. font-size: 12.5px  ->  calc(12.5px * var(--text-scale))
css = css.replace(/(^|[;{\s])font-size:\s*([0-9]*\.?[0-9]+)px(\s*(?:!important)?\s*[;}])/g, (m, pre, n, post) => {
  stats.fontSize++;
  return `${pre}font-size: calc(${num(n)}px * var(--text-scale))${post}`;
});

// 2. border-radius values in px (pills and circles keep their large or percentage values)
css = css.replace(/(^|[;{\s])(border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius):\s*([^;}]+?)(\s*(?:!important)?\s*[;}])/g, (m, pre, prop, value, post) => {
  if (/var\(|calc\(/.test(value)) return m;
  const changed = value.replace(/(^|\s)([0-9]*\.?[0-9]+)px(?=\s|$)/g, (mm, sp, n) => {
    const x = Number(n);
    if (x === 0 || x >= 100) return mm;
    stats.radius++;
    return `${sp}calc(${num(n)}px * var(--radius-scale))`;
  });
  return `${pre}${prop}: ${changed}${post}`;
});

// 3. Colours written as rgb(r g b / a) become mixes of tokens.
const known = new Map([
  ['0 0 0', '--shadow-ink'],
  ['255 255 255', '--wash'],
  ['120 192 138', '--ok'],
  ['240 168 50', '--warn'],
  ['242 106 92', '--bad'],
  ['134 164 240', '--busy'],
  ['143 181 150', '--accent'],
  ['5 5 4', '--scrim'],
  ['11 11 10', '--bg'],
]);
css = css.replace(/rgb\((\d+ \d+ \d+) \/ ([0-9.]+)\)/g, (m, rgb, a, offset) => {
  let token = known.get(rgb);
  if (!token) return m;
  // The white highlight on solid buttons keeps its own token; elsewhere white is a neutral wash.
  const before = css.slice(Math.max(0, offset - 90), offset);
  if (token === '--wash' && /inset 0 1px 0 $/.test(before)) token = '--gloss';
  stats.colour++;
  return `color-mix(in srgb, var(${token}) ${num(Number(a) * 100)}%, transparent)`;
});

writeFileSync(file, css.split('\n').join(eol));
console.log(stats);
