// Extends the demo stack with the 0.7.1.1 "Rookery" features: a local Stripe stand-in, a mail sink, plans, customers who
// bought them, a late payment, a pending sign-up. Used for the documentation screenshots and for looking around by hand.
// Nothing here talks to a real payment provider or sends real email.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootDemo, seedDemo, ADMIN, API } from './demo.mjs';
import { startStripeMock } from '../../api/test/stripe-mock.mjs';
import { client, dbQuery, sleep } from '../../api/test/harness.mjs';

// The mail sink uses the API's test dependencies.
const apiRequire = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'package.json'));
const { SMTPServer } = apiRequire('smtp-server');
const { simpleParser } = apiRequire('mailparser');

export const SHOP = { terms: 'https://example.com/terms', privacy: 'https://example.com/privacy' };
export const CUSTOMER = { email: 'dana@willowhost.example', password: 'willow-stream-4471-x' };

export async function bootRookery() {
  const mails = [];
  const smtp = new SMTPServer({
    authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
    onData(stream, session, cb) { simpleParser(stream).then((m) => { mails.push({ to: m.to?.text, subject: m.subject, text: m.text, html: m.html }); cb(); }).catch(cb); },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  const stripe = await startStripeMock({ webhookUrl: `${API}/api/billing/webhooks/stripe`, secret: 'whsec_demosecret' });
  const demo = await bootDemo({ hostMap: `api.stripe.com=127.0.0.1:${stripe.port}` });
  const stop = async () => { await demo.stop(); smtp.close(); await stripe.stop(); };
  return { ...demo, stripe, smtp, mails, smtpPort: smtp.server.address().port, stop };
}

/** Everything a hosting business would have set up, with a few customers part-way through their life cycle. */
export async function seedRookery(demo, seeded) {
  const { c, stack, stripe, smtpPort } = demo;
  const ok = c.ok;
  const db = (sql, args) => dbQuery(stack.databaseUrl, sql, args);
  const put = async (section, patch) => {
    const cur = ok(await c.call('GET', '/api/settings'), 'settings')[section];
    const body = { ...cur, ...patch };
    for (const k of Object.keys(body)) if (k.endsWith('Set')) delete body[k];
    return ok(await c.call('PUT', `/api/settings/${section}`, body), 'settings ' + section);
  };

  ok(await c.call('PUT', '/api/settings/email', { enabled: true, host: '127.0.0.1', port: smtpPort, security: 'none', user: 'mailer', password: 'sink', from: 'Willow Hosting <hello@willowhost.example>', replyTo: 'support@willowhost.example', adminBcc: 'billing@willowhost.example', perMinute: 120, maxAttempts: 8, logDays: 30 }), 'email');
  await c.call('PUT', '/api/templates/minecraft-java/store', { customerVisible: true, customerDescription: 'Vanilla, Paper, Fabric and more. The most popular choice.' });

  // The payment plugin that ships with the panel, in test mode with a local stand-in for Stripe.
  ok(await c.call('POST', '/api/plugins', { source: 'bundled', id: 'stripe', acceptPermissions: true }), 'install stripe');
  ok(await c.call('PUT', '/api/plugins/stripe/settings', { secretKey: 'sk_test_demokey123', webhookSecret: 'whsec_demosecret' }), 'stripe keys');
  ok(await c.call('PATCH', '/api/plugins/stripe', { enabled: true }), 'enable stripe');

  await put('billing', { provider: 'stripe', currency: 'eur', currencies: ['eur', 'usd'], reminderDays: [3, 14], suspendAfterDays: 7, retentionDays: 30 });
  await put('signup', { mode: 'open', requireTerms: true, termsUrl: SHOP.terms, privacyUrl: SHOP.privacy, termsVersion: '2026-10' });
  await put('selfService', { mode: 'custom', allowDelete: true, deleteCoolingHours: 24 });
  await put('limits', { enabled: true, mode: 'enforce', showUsage: true, defaults: { maxServers: 1, maxMemoryMb: 4096, maxDiskMb: 20480, maxServerMemoryMb: 4096, backups: 5, sftp: true } });

  // --- Plans -------------------------------------------------------------------------------------------------------
  const plan = async (body) => ok(await c.call('POST', '/api/plans', body), 'plan ' + body.name);
  const starter = await plan({ name: 'Starter', kind: 'server', description: 'A small free server to try things out.', features: ['1 GB memory', 'Weekly backups', 'Community support'], options: { free: true, badge: 'Free' },
    preset: { templateId: 'minecraft-java', memoryMb: 1024, cpuPercent: 50, diskMb: 5120, locations: [] }, prices: [{ cycle: 'month', amount: 0, currency: 'eur' }] });
  const friends = await plan({ name: 'Friends', kind: 'server', description: 'Plenty of room for a group of friends.', features: ['2 GB memory', '1 CPU core', 'Daily backups', 'DDoS protection'], perCustomerMax: 3,
    preset: { templateId: 'minecraft-java', memoryMb: 2048, cpuPercent: 100, diskMb: 15360, locations: ['Frankfurt', 'Helsinki'], editableVariables: ['MOTD'] },
    prices: [{ cycle: 'month', amount: 800, currency: 'eur' }, { cycle: 'quarter', amount: 2250, currency: 'eur' }, { cycle: 'year', amount: 8000, currency: 'eur' }] });
  const community = await plan({ name: 'Community', kind: 'server', description: 'For a whole community: modpacks and plenty of players.', features: ['4 GB memory', '2 CPU cores', 'Daily backups', 'Priority support', 'Free first week'], options: { highlight: true, badge: 'Most popular' }, perCustomerMax: 3,
    preset: { templateId: 'minecraft-java', memoryMb: 4096, cpuPercent: 200, diskMb: 30720, locations: ['Frankfurt', 'Helsinki', 'Ashburn'], editableVariables: ['MOTD'] },
    prices: [{ cycle: 'month', amount: 1500, currency: 'eur', trialDays: 7 }, { cycle: 'quarter', amount: 4200, currency: 'eur', trialDays: 7 }, { cycle: 'year', amount: 15000, currency: 'eur', trialDays: 7 }] });
  const creator = await plan({ name: 'Creator', kind: 'account', description: 'Run your own servers. This adds to what your account can use.', features: ['5 more servers', '16 GB memory in total', 'Extra ports and schedules'],
    limits: { maxServers: 5, maxMemoryMb: 16384, maxDiskMb: 102400, maxServerMemoryMb: 8192, extraPorts: 4, backups: 25 }, prices: [{ cycle: 'month', amount: 500, currency: 'eur' }, { cycle: 'year', amount: 5000, currency: 'eur' }] });

  ok(await put('store', { enabled: true, publicCatalog: true, title: 'Store', intro: 'Game servers that are ready in a minute. Cancel any time.', termsUrl: SHOP.terms, privacyUrl: SHOP.privacy, companyName: 'Willow Hosting', companyEmail: 'billing@willowhost.example', companyAddress: 'Mühlenweg 12, 20095 Hamburg', supportUrl: 'https://willowhost.example/support',
    withdrawalNotice: 'By buying, you agree that the service starts right away and that your right of withdrawal ends once it has been fully provided.', taxNote: 'Prices include VAT.', promoCodes: true, collectAddress: true }), 'store');

  // --- Customers and their purchases -----------------------------------------------------------------------------------------------------
  const make = async (email, password = 'willow-stream-4471-x') => {
    ok(await c.call('POST', '/api/customers', { email, password }), 'customer ' + email);
    const cl = client(API);
    ok(await cl.call('POST', '/api/auth/login', { email, password }), 'login ' + email);
    return cl;
  };
  const buy = async (cl, planId, cycle, name, extra = {}) => {
    const r = ok(await cl.call('POST', '/api/store/checkout', { planId, cycle, acceptTerms: true, name, ...extra }), 'checkout');
    if (r.free) return { free: true };
    const order = (await db('SELECT provider_session_id FROM orders WHERE id=$1', [r.orderId]))[0];
    return { orderId: r.orderId, ...(await stripe.completeCheckout(order.provider_session_id)) };
  };
  const dana = await make(CUSTOMER.email, CUSTOMER.password);
  const danaCommunity = await buy(dana, community.id, 'month', 'Willow Valley SMP', { variables: { MOTD: 'Welcome to Willow Valley!' } });
  await buy(dana, starter.id, 'month', 'Test World');
  const omar = await make('omar@blockworks.example');
  const omarFriends = await buy(omar, friends.id, 'year', 'Redstone Lab');
  const lena = await make('lena@pixelhaven.example');
  const lenaFriends = await buy(lena, friends.id, 'month', 'Pixel Haven');
  await buy(lena, creator.id, 'month', 'Creator');
  const tom = await make('tom@lanternclub.example');
  const tomFriends = await buy(tom, friends.id, 'month', 'Lantern Club');
  await sleep(6000);
  await stripe.renew(omarFriends.subscriptionId);
  await stripe.failRenewal(tomFriends.subscriptionId);
  // lena cancels (ends at the period end)
  await lena.call('POST', `/api/billing/subscriptions/${(await db('SELECT id FROM subscriptions WHERE provider_subscription_id=$1', [lenaFriends.subscriptionId]))[0].id}/cancel`, {});
  await sleep(4000);

  // --- A person waiting for approval, one who never confirmed, and a staff plan ---------------------------------------------------
  await put('signup', { mode: 'approval' });
  const anon = client(API);
  await anon.call('POST', '/api/auth/register', { email: 'nina@campuscraft.example', password: 'correct-horse-battery-9', acceptTerms: true });
  await anon.call('POST', '/api/auth/register', { email: 'paul@newplayer.example', password: 'another-long-passphrase-2', acceptTerms: true });
  await sleep(1500);
  const nina = (await db("SELECT id FROM users WHERE email='nina@campuscraft.example'"))[0];
  if (nina) await db("UPDATE users SET status='pending_approval',email_verified_at=now() WHERE id=$1", [nina.id]);
  await put('signup', { mode: 'open' });
  await sleep(1500);
  return { dana, plans: { starter, friends, community, creator }, danaCommunity };
}

export { seedDemo, ADMIN, API };
