// Screenshots for the 0.7.1.1 "Rookery" pages. They use the Rookery demo (rookery-demo.mjs): a fictional hosting business,
// "Willow Hosting", with plans, customers and a local stand-in for Stripe. Run them with
//   ONLY=store,store-buy,billing-customer,... npm run screenshots
import { CUSTOMER } from './rookery-demo.mjs';

const go = async ({ page, WEB, sleep }, path, text) => {
  await page.goto(WEB + path);
  if (text) await page.getByText(text, { exact: false }).first().waitFor({ timeout: 20000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(900);
};

/** Runs a shot as the demo customer in a browser of their own. */
async function asCustomer(ctx, fn) {
  const browser = ctx.context.browser();
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'dark', locale: 'en-US', timezoneId: 'Europe/Berlin' });
  const r = await fetch(ctx.API + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CUSTOMER) });
  const cookie = /fledge_session=([^;]+)/.exec(r.headers.get('set-cookie') || '')?.[1];
  await context.addCookies([{ name: 'fledge_session', value: decodeURIComponent(cookie), domain: 'localhost', path: '/' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try { await fn({ ...ctx, page, save: (name, locator, clip) => ctx.save(name, locator, clip, page) }); } finally { await context.close(); }
}

const settingsCard = async (ctx, id, name) => {
  await go(ctx, '/settings', 'Customers, store and email');
  const card = ctx.page.locator(id);
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await ctx.sleep(500);
  await ctx.save(name, card);
};

export const rookeryShots = {
  async store(ctx) { await asCustomer(ctx, async (c) => { await go(c, '/store', 'Community'); await c.save('store'); }); },
  async 'store-buy'(ctx) {
    await asCustomer(ctx, async (c) => {
      await go(c, '/store', 'Community');
      await c.page.getByRole('article', { name: 'Friends' }).getByRole('button', { name: 'Choose plan' }).click();
      await c.page.locator('.modal').waitFor();
      await c.page.getByLabel('Server name').fill('Redstone Lab');
      await c.page.getByLabel('Location').selectOption('Frankfurt');
      await c.page.getByRole('checkbox').check();
      await c.sleep(600);
      await c.save('store-buy', c.page.locator('.modal'));
    });
  },
  async 'billing-customer'(ctx) { await asCustomer(ctx, async (c) => { await go(c, '/billing', 'Community'); await c.save('billing-customer'); }); },
  async 'self-service-create'(ctx) {
    await asCustomer(ctx, async (c) => {
      await go(c, '/servers?new=1', 'Kind of server');
      await c.page.locator('.drawer input[maxlength="80"]').fill('Our survival world').catch(() => {});
      await c.sleep(600);
      await c.save('self-service-create', c.page.locator('.drawer'));
    });
  },
  async 'billing-overview'(ctx) { await go(ctx, '/billing', 'Monthly recurring revenue'); await ctx.save('billing-overview'); },
  async 'billing-plans'(ctx) { await go(ctx, '/billing?tab=plans', 'Friends'); await ctx.save('billing-plans'); },
  async 'billing-plan-editor'(ctx) {
    await go(ctx, '/billing?tab=plans', 'Friends');
    await ctx.page.getByRole('row').filter({ hasText: 'Community' }).getByRole('button', { name: 'Edit' }).click();
    await ctx.page.locator('.drawer').waitFor();
    await ctx.sleep(900);
    await ctx.page.locator('.drawer__body').evaluate((el) => { el.scrollTop = 520; });
    await ctx.sleep(500);
    await ctx.save('billing-plan-editor', ctx.page.locator('.drawer'));
    await ctx.page.keyboard.press('Escape');
  },
  async 'billing-subscription'(ctx) {
    await go(ctx, '/billing?tab=subscriptions', 'tom@lanternclub.example');
    await ctx.page.getByRole('row').filter({ hasText: 'tom@lanternclub.example' }).getByRole('button', { name: 'Open' }).click();
    await ctx.page.locator('.timeline').waitFor();
    await ctx.sleep(900);
    await ctx.save('billing-subscription', ctx.page.locator('.drawer'));
    await ctx.page.keyboard.press('Escape');
  },
  async 'billing-health'(ctx) { await go(ctx, '/billing?tab=health', 'Recent payment events'); await ctx.sleep(1200); await ctx.save('billing-health'); },
  async 'settings-signup'(ctx) { await settingsCard(ctx, '#signup', 'settings-signup'); },
  async 'settings-self-service'(ctx) { await settingsCard(ctx, '#self-service', 'settings-self-service'); },
  async 'settings-limits'(ctx) { await settingsCard(ctx, '#limits', 'settings-limits'); },
  async 'settings-store'(ctx) { await settingsCard(ctx, '#store', 'settings-store'); },
  async 'email-templates'(ctx) {
    await go(ctx, '/settings', 'Customers, store and email');
    const card = ctx.page.locator('#email-templates');
    await card.getByRole('button', { name: /Payment received/ }).click();
    await ctx.page.waitForSelector('iframe.mail__preview');
    await card.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await ctx.sleep(1200);
    await ctx.save('email-templates');
  },
  async 'customers-pending'(ctx) { await go(ctx, '/customers', 'Waiting for you'); await ctx.save('customers-pending', undefined, { x: 236, y: 0, width: 1124, height: 620 }); },
  async 'limits-usage'(ctx) {
    await go(ctx, '/customers', 'dana@willowhost.example');
    await ctx.page.getByRole('button', { name: /Details for dana@/ }).click();
    await ctx.page.getByRole('button', { name: 'Edit limits' }).first().click();
    await ctx.page.getByText('What applies now').waitFor();
    await ctx.sleep(900);
    await ctx.save('limits-usage');
    await ctx.page.keyboard.press('Escape');
    await ctx.page.keyboard.press('Escape');
  },
  async 'stripe-plugin'(ctx) {
    await go(ctx, '/plugins', 'Plugins');
    await ctx.page.getByRole('group', { name: 'Plugin list' }).getByRole('button', { name: /Installed/ }).click();
    const plugin = ctx.page.locator('.plug-row').filter({ hasText: 'Stripe Payments' });
    await plugin.waitFor({ state: 'visible' });
    if (await plugin.count() !== 1) throw new Error('Expected exactly one installed Stripe Payments plugin');
    await plugin.getByRole('button', { name: 'Configure' }).click();
    const drawer = ctx.page.locator('.drawer-id');
    await drawer.getByText('Stripe Payments', { exact: true }).waitFor({ state: 'visible' });
    await ctx.sleep(500);
    await ctx.save('stripe-plugin');
    await ctx.page.keyboard.press('Escape');
  },
  async 'signup-form'(ctx) {
    const browser = ctx.context.browser();
    const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'dark', locale: 'en-US' });
    const page = await context.newPage();
    try {
      await page.goto(ctx.WEB + '/');
      await page.getByRole('button', { name: 'Create an account' }).click();
      await page.getByText('Create your account').waitFor();
      await page.getByLabel('Email').fill('you@example.com');
      await page.getByLabel('Password', { exact: true }).fill('a-long-passphrase-123');
      await page.getByLabel('Confirm password').fill('a-long-passphrase-123');
      await page.getByRole('checkbox').check();
      await ctx.sleep(700);
      await ctx.save('signup-form', undefined, undefined, page);
    } finally { await context.close(); }
  },
};
