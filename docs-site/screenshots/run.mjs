// Takes the documentation screenshots from a seeded demo stack and writes optimized WebP files into docs/public/screenshots.
//
//   cd api && npm ci && cd ../plugins/host && npm ci && cd ../web && NEXT_PUBLIC_API_URL=http://localhost:4300 npm run build
//   cd ../docs-site && npm ci
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm run screenshots
//
// ONLY=nodes,files limits the run to some screenshots. CHROME_PATH points at a Chrome/Chromium binary (default: the installed Chrome).
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { seedDemo, seedConsole, ADMIN, WEB, API } from './demo.mjs';
import { bootRookery, seedRookery } from './rookery-demo.mjs';
import { sleep } from '../../api/test/harness.mjs';
import { shots } from './shots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { authenticator } = createRequire(join(here, '..', '..', 'api', 'package.json'))('otplib');
const outDir = join(here, '..', 'docs', 'public', 'screenshots');
mkdirSync(outDir, { recursive: true });
const only = (process.env.ONLY || '').split(',').filter(Boolean);

const demo = await bootRookery();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'en-US', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  const save = async (name, locator, clip, shotPage = page) => {
    const png = locator ? await locator.screenshot() : await shotPage.screenshot(clip ? { clip } : undefined);
    // WebP through the browser's own encoder: no extra dependencies.
    const conv = await context.newPage();
    const b64 = await conv.evaluate(async (data) => {
      const blob = await (await fetch('data:image/png;base64,' + data)).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      const buf = new Uint8Array(await out.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, png.toString('base64'));
    await conv.close();
    writeFileSync(join(outDir, `${name}.webp`), Buffer.from(b64, 'base64'));
    console.log('saved', name);
  };

  // The first-run screen only exists before the first administrator does.
  const ctx = { demo, page, context, save, sleep, WEB, API, ADMIN, authenticator, seedConsole, only, state: {} };
  if (!only.length || only.includes('first-run')) {
    await page.goto(WEB + '/');
    await page.waitForLoadState('networkidle');
    await sleep(800);
    await save('first-run', undefined, { x: 400, y: 215, width: 560, height: 420 });
  }

  const seeded = await seedDemo(demo);
  ctx.seeded = seeded;
  // The hosting side: plans, store, subscriptions, sign-ups (a local stand-in for Stripe; nothing real).
  await seedRookery(demo, seeded);
  // Sign in through the API and hand the session cookie to the browser.
  const step = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, stepwise: true }) }).then((r) => r.json());
  const res = await fetch(API + '/api/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: step.challenge, code: authenticator.generate(seeded.totpSecret) }) });
  const cookie = /fledge_session=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
  if (!cookie) throw new Error('could not sign in to the demo');
  await context.addCookies([{ name: 'fledge_session', value: decodeURIComponent(cookie), domain: 'localhost', path: '/' }]);
  await sleep(3000);

  for (const [name, fn] of Object.entries(shots)) {
    if (only.length && !only.includes(name)) continue;
    try { await fn(ctx); } catch (e) {
      console.error(`FAILED ${name}: ${String(e.message).split('\n')[0]}`);
      process.exitCode = 1;
      try { unlinkSync(join(outDir, `${name}.webp`)); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
      await page.screenshot({ path: join(outDir, `_failed-${name}.png`) }).catch(() => {});
    }
  }
} finally {
  await browser.close();
  await demo.stop();
}
process.exit(process.exitCode || 0);
