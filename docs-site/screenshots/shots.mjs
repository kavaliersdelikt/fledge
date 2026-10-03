// One entry per screenshot. Each receives { page, save, sleep, WEB, seeded, demo, seedConsole }.
// Keep them short and resilient: wait for visible text, not for fixed times.

const go = async ({ page, WEB, sleep }, path, text) => {
  await page.goto(WEB + path);
  if (text) await page.getByText(text, { exact: false }).first().waitFor({ timeout: 20000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(900);
};

const card = (page, title) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();

export const shots = {
  async nodes(ctx) { await go(ctx, '/nodes', 'frankfurt-01'); await ctx.save('nodes'); },
  async customers(ctx) { await go(ctx, '/customers', 'alex@orbit-games.example'); await ctx.save('customers'); },
  async activity(ctx) { await go(ctx, '/activity', 'Activity'); await ctx.save('activity'); },
  async 'account-security'(ctx) { await go(ctx, '/settings', 'Passkeys'); await ctx.save('account-security'); },
  async settings(ctx) {
    await go(ctx, '/settings', 'Object storage');
    await card(ctx.page, 'Object storage').scrollIntoViewIfNeeded();
    await ctx.sleep(500);
    await ctx.save('settings');
  },
  async 'plugins-store'(ctx) { await go(ctx, '/plugins', 'Plugins'); await ctx.save('plugins-store'); },
  async 'server-console'(ctx) {
    await go(ctx, `/servers/${ctx.seeded.paper.id}`, ctx.seeded.paper.name);
    await ctx.page.getByText('Mara_Plays joined the game').first().waitFor({ timeout: 20000 });
    await ctx.sleep(2500);
    await ctx.save('server-console');
  },
  async files(ctx) { await go(ctx, `/servers/${ctx.seeded.paper.id}?tab=files`, 'server.properties'); await ctx.save('files'); },
  async backups(ctx) { await go(ctx, `/servers/${ctx.seeded.paper.id}?tab=backups`, 'Backup'); await ctx.save('backups'); },
  async 'schedule-editor'(ctx) {
    await go(ctx, `/servers/${ctx.seeded.paper.id}?tab=schedules`, 'Nightly restart');
    await ctx.page.getByText('Edit', { exact: true }).first().click();
    await ctx.sleep(1200);
    await ctx.save('schedule-editor');
  },
  async 'addons-installed'(ctx) { await go(ctx, `/servers/${ctx.seeded.fabric.id}?tab=addons`, 'Mods'); await ctx.save('addons-installed'); },

  async 'usage-history'(ctx) {
    await go(ctx, `/servers/${ctx.seeded.paper.id}`, ctx.seeded.paper.name);
    await ctx.page.getByText('Usage history').first().click();
    await ctx.page.getByRole('button', { name: '24h' }).click().catch(() => ctx.page.getByText('24h', { exact: true }).click());
    await ctx.sleep(1800);
    await ctx.save('usage-history');
  },
  async startup(ctx) {
    await go(ctx, `/servers/${ctx.seeded.paper.id}?tab=settings`, 'Startup');
    await ctx.save('startup', card(ctx.page, 'Startup'));
  },
  async ports(ctx) {
    await go(ctx, `/servers/${ctx.seeded.paper.id}?tab=settings`, 'Dynmap');
    await ctx.save('ports', card(ctx.page, 'Network'));
  },
  async clone(ctx) {
    await go(ctx, `/servers/${ctx.seeded.paper.id}`, ctx.seeded.paper.name);
    await ctx.page.getByLabel('More power actions').click();
    await ctx.page.getByText('Clone…').click();
    await ctx.sleep(1200);
    await ctx.save('clone');
  },
  async 'crash-protection'(ctx) {
    await go(ctx, `/servers/${ctx.seeded.paper.id}?tab=schedules`, 'Nightly restart');
    const c = ctx.page.locator('section.card').filter({ hasText: 'Crash protection' }).last();
    await c.scrollIntoViewIfNeeded();
    await ctx.sleep(500);
    await ctx.save('crash-protection', c);
  },
  async notifications(ctx) {
    await go(ctx, '/servers', 'Survival SMP');
    await ctx.page.getByText('Notifications', { exact: true }).first().click();
    await ctx.page.getByText('Skyblock crashed').first().waitFor({ timeout: 10000 });
    await ctx.sleep(800);
    await ctx.save('notifications');
  },
  async 'template-editor'(ctx) {
    await go(ctx, '/templates', 'Templates');
    await ctx.page.getByRole('row').filter({ hasText: 'Minecraft Paper' }).getByText('Edit', { exact: true }).click();
    await ctx.sleep(1800);
    await ctx.save('template-editor');
  },
  async 'addons-browse'(ctx) {
    await go(ctx, `/servers/${ctx.seeded.fabric.id}?tab=addons`, 'Mods');
    await ctx.page.getByText('Lithium', { exact: false }).first().waitFor({ timeout: 25000 });
    await ctx.sleep(1500);
    await ctx.save('addons-browse');
  },
  async 'plugins-install'(ctx) {
    await go(ctx, '/plugins', 'Modrinth Plugin Browser');
    await ctx.page.getByText('Install', { exact: true }).first().click();
    await ctx.sleep(2000);
    await ctx.save('plugins-install');
    await ctx.page.keyboard.press('Escape');
    await ctx.sleep(500);
  },
  async 'plugins-configure'(ctx) {
    await go(ctx, '/plugins', 'Modrinth Mod Browser');
    await ctx.page.getByText('Configure', { exact: true }).first().click();
    await ctx.sleep(1500);
    await ctx.save('plugins-configure');
  },
  async 'addons-plan'(ctx) {
    await go(ctx, `/servers/${ctx.seeded.fabric.id}?tab=addons`, 'Mods');
    await ctx.page.getByText('Cloth Config API').first().waitFor({ timeout: 25000 });
    await ctx.page.getByText('Cloth Config API').first().click();
    await ctx.sleep(2500);
    await ctx.save('addons-project');
    await ctx.page.getByRole('button', { name: /^Install/ }).first().click();
    await ctx.sleep(3500);
    await ctx.save('addons-plan');
  },
};
