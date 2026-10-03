// Visual regression for refactors of the panel's CSS. It does not compare pixels (the demo data moves); it records the computed
// style of every element on a set of screens and compares two recordings.
//
//   web: NEXT_PUBLIC_API_URL=http://localhost:4300 npm run build
//   node screenshots/regress.mjs record before.json      # before the change
//   node screenshots/regress.mjs record after.json       # after it (rebuild the panel first)
//   node screenshots/regress.mjs compare before.json after.json
//
// MODE=light records the light theme (data-mode="light") when the panel supports it. SHOTS=dir also saves a PNG per screen.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { bootDemo, seedDemo, ADMIN, WEB, API } from './demo.mjs';
import { sleep } from '../../api/test/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, a, b] = process.argv.slice(2);

const PROPS = ['fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'borderTopColor', 'borderTopWidth',
  'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'boxShadow', 'opacity', 'outlineColor', 'caretColor', 'fill', 'stroke'];

// color-mix() serialises as color(srgb ...) where a plain colour serialises as rgba(...): compare the same colour as equal.
const norm = (v) => String(v ?? '').replace(/color\(srgb ([0-9.]+) ([0-9.]+) ([0-9.]+)(?: \/ ([0-9.]+))?\)/g, (m, r, g, b, a) =>
  `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a === undefined ? 1 : Number(Number(a).toFixed(3))})`)
  .replace(/rgb\((\d+), (\d+), (\d+)\)/g, 'rgba($1, $2, $3, 1)');

if (cmd === 'compare') {
  const x = JSON.parse(readFileSync(a, 'utf8')), y = JSON.parse(readFileSync(b, 'utf8'));
  let bad = 0, total = 0;
  for (const screen of Object.keys(x)) {
    // Rows are matched by tag, classes and how many of those came before, not by position, so an added element does not shift the rest.
    const index = (rows) => {
      const seen = new Map(), map = new Map();
      for (const [k, ...v] of rows) {
        const key = k.replace(/^\d+:/, '');
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        map.set(`${key}#${n}`, v);
      }
      return map;
    };
    const p = x[screen], q = y[screen];
    if (!q) { console.log(`MISSING screen ${screen}`); bad++; continue; }
    const mp = index(p), mq = index(q);
    let diffs = 0; const sample = [];
    for (const [key, vp] of mp) {
      total++;
      const vq = mq.get(key);
      if (!vq) { diffs++; if (sample.length < 4) sample.push(`${key}: missing after`); continue; }
      const d = PROPS.filter((_, j) => norm(vp[j]) !== norm(vq[j]));
      if (d.length) { diffs++; if (sample.length < 4) sample.push(`${key}: ${d.map((k) => `${k} ${vp[PROPS.indexOf(k)]} -> ${vq[PROPS.indexOf(k)]}`).join('; ')}`); }
    }
    const added = [...mq.keys()].filter((k) => !mp.has(k));
    const n = mp.size;
    const note = added.length ? ` (new elements: ${[...new Set(added.map((k) => k.replace(/#\d+$/, '')))].slice(0, 4).join(', ')})` : '';
    console.log(`${diffs ? 'DIFF' : 'same'}  ${screen}: ${diffs}/${n} elements differ${note}`);
    for (const s of sample) console.log('      ' + s);
    bad += diffs;
  }
  console.log(`${total} elements compared, ${bad} differ`);
  process.exit(bad ? 1 : 0);
}

const out = a;
if (cmd !== 'record' || !out) { console.error('usage: regress.mjs record <file.json> | compare <a.json> <b.json>'); process.exit(2); }
const { authenticator } = createRequire(join(here, '..', '..', 'api', 'package.json'))('otplib');
const demo = await bootDemo();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const result = {};
try {
  const seeded = await seedDemo(demo);
  await sleep(2500);
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: process.env.MODE === 'light' ? 'light' : 'dark', locale: 'en-US', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const record = async (name, url) => {
    await page.goto(WEB + url);
    await page.waitForLoadState('networkidle');
    await sleep(1200);
    await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await sleep(200);
    result[name] = await page.evaluate((props) => {
      const rows = [];
      let i = 0;
      for (const el of document.body.querySelectorAll('*')) {
        if (['SCRIPT', 'STYLE', 'NEXT-ROUTE-ANNOUNCER'].includes(el.tagName)) continue;
        const cs = getComputedStyle(el);
        const key = `${i++}:${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''}`;
        rows.push([key, ...props.map((p) => cs[p])]);
      }
      return rows;
    }, PROPS);
    if (process.env.SHOTS) { mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.SHOTS, name + '.png') }); }
    console.log('recorded', name, result[name].length);
  };
  await record('login', '/');
  const step = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, stepwise: true }) }).then((r) => r.json());
  const res = await fetch(API + '/api/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: step.challenge, code: authenticator.generate(seeded.totpSecret) }) });
  const cookie = /fledge_session=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
  if (!cookie) throw new Error('could not sign in');
  await context.addCookies([{ name: 'fledge_session', value: decodeURIComponent(cookie), domain: 'localhost', path: '/' }]);
  const servers = await fetch(API + '/api/servers', { headers: { cookie: 'fledge_session=' + cookie } }).then((r) => r.json());
  const list = Array.isArray(servers) ? servers : servers.items;
  const first = list?.[0]?.id;
  const screens = { overview: '/', servers: '/servers', nodes: '/nodes', resilience: '/resilience', templates: '/templates', plugins: '/plugins', customers: '/customers', activity: '/activity', api: '/api', updates: '/updates', settings: '/settings', install: '/install' };
  for (const [name, url] of Object.entries(screens)) await record(name, url);
  if (first) { for (const tab of ['', '?tab=files', '?tab=backups', '?tab=settings']) await record('server' + (tab || '-console').replace(/[?=]/g, '-'), `/servers/${first}${tab}`); }
  writeFileSync(out, JSON.stringify(result));
  console.log('wrote', out);
} finally {
  await browser.close();
  await demo.stop();
}
process.exit(0);
