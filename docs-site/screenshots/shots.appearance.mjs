// Screenshots for Appearance (0.6.2.1). They come last in the run because they change the look of the whole demo panel.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const go = async ({ page, WEB, sleep }, path, text) => {
  await page.goto(WEB + path);
  if (text) await page.getByText(text, { exact: false }).first().waitFor({ timeout: 20000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(900);
};

async function getBranding(ctx) {
  const r = await ctx.demo.c.call('GET', '/api/branding/admin');
  if (r.code !== 200) throw new Error('could not read the appearance: ' + JSON.stringify(r.data));
  return r.data.branding;
}
async function putBranding(ctx, b) {
  const r = await ctx.demo.c.call('PUT', '/api/branding', { branding: b, baseRevision: b.revision });
  if (r.code !== 200) throw new Error('could not save the appearance: ' + JSON.stringify(r.data));
  return r.data.branding;
}
async function upload(ctx, kind, file, type) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', new Blob([readFileSync(join(here, 'assets', file))], { type }), file);
  const res = await fetch(ctx.demo.stack.base + '/api/branding/assets', { method: 'POST', headers: { cookie: ctx.demo.c.cookie }, body: fd });
  if (!res.ok) throw new Error('upload failed: ' + (await res.text()));
  return (await res.json()).sha256;
}

/** A fictional hosting company, used in every appearance screenshot. */
async function setLumen(ctx) {
  const mark = await upload(ctx, 'mark', 'lumen-mark.svg', 'image/svg+xml');
  let b = await getBranding(ctx);
  b.identity = { ...b.identity, name: 'Lumen Hosting', shortName: 'Lumen', tagline: 'Game servers without the fuss', emailFromName: 'Lumen Support', showPoweredBy: true };
  b.email.footer = 'Lumen Hosting, 12 Example Street\nsupport@lumen.example';
  b.assets.mark = mark;
  b.theme = { ...b.theme, preset: 'custom', mode: 'dark', dark: { accent: '#5cd6c6', neutralHue: 210, neutralChroma: 0.02 }, light: { accent: '#0f766e', neutralHue: 200, neutralChroma: 0.012 }, font: 'geist', radius: 10, density: 'comfortable' };
  b.login = {
    welcome: 'Sign in to manage your servers.',
    background: 'gradient',
    layout: 'split',
    footerLinks: [
      { label: 'Terms', url: 'https://lumen.example/terms', icon: 'link', newTab: true },
      { label: 'Privacy', url: 'https://lumen.example/privacy', icon: 'link', newTab: true },
    ],
  };
  b.navigation = {
    labels: { servers: 'Worlds' },
    links: [
      { label: 'Status page', url: 'https://status.lumen.example', icon: 'activity', newTab: true },
      { label: 'Discord', url: 'https://discord.gg/example', icon: 'message-circle', newTab: true },
    ],
  };
  b.announcement = { enabled: true, tone: 'info', text: 'Scheduled maintenance on Saturday at **22:00 UTC**. Servers restart once. [Details](https://status.lumen.example)', audience: 'everyone', dismissible: true, startsAt: null, endsAt: null, id: '' };
  b = await putBranding(ctx, b);
  await ctx.sleep(4500); // the panel's server caches the appearance for a few seconds
  // A second version, so the history has something to show.
  b.identity.tagline = 'Game servers without the fuss';
  b.theme.textScale = 1;
  b.email.footer = 'Lumen Hosting, 12 Example Street\nsupport@lumen.example\nOpening hours: every day, 08:00 to 22:00 UTC';
  await putBranding(ctx, b);
  await ctx.sleep(4500);
}

async function ensureLumen(ctx) {
  if (ctx.state.lumen) return;
  ctx.state.lumen = true;
  await setLumen(ctx);
}

async function themed(ctx, name, mutate) {
  await ensureLumen(ctx);
  const b = await getBranding(ctx);
  mutate(b);
  // The landing page uses these three next to each other; only the Lumen one keeps the announcement.
  if (name !== 'theme-lumen') b.announcement.enabled = false;
  await putBranding(ctx, b);
  await ctx.sleep(4500);
  await go(ctx, '/servers', 'Running');
  await ctx.page.getByText('Survival SMP').first().waitFor({ timeout: 15000 });
  await ctx.sleep(1200);
  await ctx.save(name);
}

export const appearanceShots = {
  async 'appearance-identity'(ctx) {
    await ensureLumen(ctx);
    await go(ctx, '/settings/appearance', 'Lumen Hosting');
    await ctx.save('appearance-identity');
  },
  async 'appearance-colors'(ctx) {
    await ensureLumen(ctx);
    await go(ctx, '/settings/appearance', 'Appearance');
    await ctx.page.getByRole('tab', { name: 'Colours' }).click();
    await ctx.page.getByRole('heading', { name: 'Readability: dark palette' }).scrollIntoViewIfNeeded();
    await ctx.sleep(800);
    await ctx.save('appearance-colors');
  },
  async 'appearance-history'(ctx) {
    await ensureLumen(ctx);
    await go(ctx, '/settings/appearance', 'Appearance');
    await ctx.page.getByRole('tab', { name: 'Advanced' }).click();
    await ctx.page.getByRole('heading', { name: 'Earlier versions' }).scrollIntoViewIfNeeded();
    await ctx.sleep(800);
    await ctx.save('appearance-history');
  },
  async 'appearance-banner'(ctx) {
    await ensureLumen(ctx);
    await go(ctx, '/servers', 'Worlds');
    await ctx.page.getByText('Scheduled maintenance').first().waitFor({ timeout: 15000 });
    await ctx.save('appearance-banner');
  },
  async 'appearance-signin'(ctx) {
    await ensureLumen(ctx);
    const anon = await ctx.context.browser().newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'dark', locale: 'en-US' });
    const p = await anon.newPage();
    await p.goto(ctx.WEB + '/');
    await p.getByText('Game servers without the fuss').first().waitFor({ timeout: 20000 });
    await ctx.sleep(1200);
    await ctx.save('appearance-signin', undefined, undefined, p);
    await anon.close();
  },
  // Themed panels for the documentation and the landing page.
  async 'theme-lumen'(ctx) {
    await themed(ctx, 'theme-lumen', () => {});
  },
  async 'theme-paper'(ctx) {
    await themed(ctx, 'theme-paper', (b) => {
      b.identity.name = 'Paperplane';
      b.assets.mark = null;
      b.theme.preset = 'paper';
      b.theme.mode = 'light';
      b.theme.dark = { accent: '#8fb596', neutralHue: 96, neutralChroma: 0.01 };
      b.theme.light = { accent: '#2f6b46', neutralHue: 90, neutralChroma: 0.012 };
      b.theme.radius = 10;
      b.theme.font = 'geist';
      b.navigation.labels = {};
    });
  },
  async 'theme-ember'(ctx) {
    await themed(ctx, 'theme-ember', (b) => {
      b.identity.name = 'Ember Servers';
      b.theme.preset = 'ember';
      b.theme.mode = 'dark';
      b.theme.dark = { accent: '#f0955a', neutralHue: 45, neutralChroma: 0.014 };
      b.theme.radius = 8;
      b.theme.font = 'inter';
      b.navigation.labels = { servers: 'Instances' };
    });
  },
  async 'theme-terminal'(ctx) {
    await themed(ctx, 'theme-terminal', (b) => {
      b.identity.name = 'node.garden';
      b.theme.preset = 'terminal';
      b.theme.mode = 'dark';
      b.theme.dark = { accent: '#58e07b', neutralHue: 150, neutralChroma: 0.01 };
      b.theme.radius = 0;
      b.theme.font = 'mono';
      b.theme.density = 'compact';
      b.navigation.labels = { servers: 'Machines' };
    });
  },
};
