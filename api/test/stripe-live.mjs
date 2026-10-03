// Runs the bundled Stripe plugin against the REAL Stripe API in test mode, using the Stripe CLI you are logged in with.
// Not part of CI (it needs your Stripe account and the CLI). Run it by hand:
//
//   cd api && node --import tsx test/stripe-live.mjs
//
// How it works without ever reading your API key: the plugin's calls to api.stripe.com are redirected (by the plugin host's
// test-only host map) to a tiny local proxy that performs each call with `stripe get|post|delete`, which uses the CLI's own
// login. Webhooks come from `stripe listen`, signed by Stripe's CLI with a signing secret printed by `stripe listen --print-secret`.
// The one step that needs a person is paying on Stripe's hosted page with a test card; everything else is driven here with
// Stripe's test objects (test clocks, test payment methods). Only test-mode data is created.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { bootStack, client, bootstrapAdmin, makeNode, heartbeat, nextJob, finishJob, dbQuery, sleep } from './harness.mjs';

const VERSION = '2024-06-20';
// On Windows the CLI installed with npm is a shim script; run it through node so arguments are passed untouched.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
function findCli() {
  if (spawnSync('stripe', ['--version'], { encoding: 'utf8' }).status === 0) return ['stripe'];
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    const shim = join(dir, 'node_modules', '@stripe', 'cli', 'bin', 'shim.js');
    if (existsSync(shim)) return [process.execPath, shim];
  }
  return null;
}
const CLI = findCli();
if (!CLI || spawnSync(CLI[0], [...CLI.slice(1), '--version'], { encoding: 'utf8' }).status !== 0) { console.error('The Stripe CLI is not installed or not on PATH.'); process.exit(2); }
const run = (args, opts) => spawn(CLI[0], [...CLI.slice(1), ...args], opts);
const runSync = (args, opts) => spawnSync(CLI[0], [...CLI.slice(1), ...args], opts);

// ---- Calling the CLI --------------------------------------------------------------------------------------------------
function cli(method, path, pairs = [], { idempotency } = {}) {
  return new Promise((resolve) => {
    const args = [method, path, '--confirm', '--stripe-version', VERSION, ...(idempotency ? ['--idempotency', idempotency] : []), ...pairs.flatMap((p) => ['-d', p])];
    const child = run(args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const text = out.trim() || err.trim();
      let json;
      try { json = JSON.parse(text.slice(text.indexOf('{'))); } catch { json = { error: { message: `The CLI answered: ${text.slice(0, 300) || '(nothing)'}` } }; }
      resolve({ json, code });
    });
  });
}
// Advancing a test clock takes Stripe a while; wait until it is ready again.
async function advance(clockId, frozenTime) {
  await stripe('post', `/v1/test_helpers/test_clocks/${clockId}/advance`, { frozen_time: frozenTime });
  for (let i = 0; i < 90; i++) {
    const c = await stripe('get', `/v1/test_helpers/test_clocks/${clockId}`);
    if (c.status === 'ready') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw Error('the test clock did not finish advancing');
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`);
const stripe = async (method, path, params = {}) => {
  const { json } = await cli(method, path, form(params));
  if (json.error) throw Error(`${method} ${path}: ${json.error.message}`);
  return json;
};

const proxyErrors = [];
// ---- The proxy the plugin talks to --------------------------------------------------------------------------------------
const proxy = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const decode = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
    const pairs = [...(url.search ? url.search.slice(1).split('&') : []), ...(body ? body.split('&') : [])].filter(Boolean).map((p) => { const i = p.indexOf('='); return `${decode(p.slice(0, i))}=${decode(p.slice(i + 1))}`; });
    const { json } = await cli(req.method.toLowerCase(), url.pathname, pairs, { idempotency: req.headers['idempotency-key'] });
    if (json.error) proxyErrors.push(`${req.method} ${url.pathname}: ${json.error.message}`);
    res.writeHead(json.error ? (json.error.type === 'invalid_request_error' ? 400 : 402) : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

// ---- Webhooks from Stripe ----------------------------------------------------------------------------------------------------
const secretRun = runSync(['listen', '--print-secret'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const whsec = /whsec_[A-Za-z0-9]+/.exec(secretRun.stdout + secretRun.stderr)?.[0];
if (!whsec) { console.error('Could not get a webhook signing secret from `stripe listen --print-secret`.'); process.exit(2); }
const API_PORT = 4185;
const listener = run(['listen', '--events', 'checkout.session.completed,checkout.session.expired,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed,invoice.payment_succeeded,invoice.finalized,invoice.voided,charge.refunded,charge.dispute.created,charge.dispute.closed', '--forward-to', `http://127.0.0.1:${API_PORT}/api/billing/webhooks/stripe`, '--skip-verify'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
let listenerLog = '';
for (const s of [listener.stdout, listener.stderr]) s.on('data', (d) => (listenerLog += d));

// ---- Mail sink and the panel -------------------------------------------------------------------------------------------------------
const mails = [];
const smtp = new SMTPServer({ authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], onAuth(a, s, cb) { cb(null, { user: a.username }); },
  onData(stream, s, cb) { simpleParser(stream).then((m) => { mails.push({ to: m.to?.text, subject: m.subject, text: m.text }); cb(); }).catch(cb); } });
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));

const stack = await bootStack({ db: 'fledge_stripe_live', apiPort: API_PORT, hostPort: 4531, mock: null, hostMap: `api.stripe.com=127.0.0.1:${proxy.address().port}`,
  apiEnv: { SLOW_SWEEP_MS: '1500', SWEEP_INTERVAL_MS: '1500', RATE_LIMIT_AUTH_WRITE: '5000' } });
const admin = client(stack.base);
const { call, ok, status, check } = admin;
const q = (sql, args) => dbQuery(stack.databaseUrl, sql, args);
const rid = () => randomBytes(3).toString('hex');
const until = async (fn, label, ms = 60000) => { const end = Date.now() + ms; for (;;) { await heartbeat(admin, node).catch(() => {}); const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('timed out waiting for ' + label); await sleep(1000); } };
const mailTo = (addr, re) => mails.filter((m) => m.to?.includes(addr) && (!re || re.test(m.subject)));
let node, failed = null;
const put = async (section, patch) => { const cur = ok(await call('GET', '/api/settings'), 's')[section]; const body = { ...cur, ...patch }; for (const k of Object.keys(body)) if (k.endsWith('Set')) delete body[k]; return call('PUT', `/api/settings/${section}`, body); };
const jobs = async () => { await heartbeat(admin, node); for (let i = 0; i < 12; i++) { const j = await nextJob(admin, node); if (!j) break; await finishJob(admin, node, j, true, {}); } };
const subRow = async (id) => (await q('SELECT * FROM subscriptions WHERE id=$1', [id]))[0];
const log = (m) => console.log('  ' + m);

try {
  await bootstrapAdmin(admin);
  ok(await call('PUT', '/api/settings/email', { enabled: true, host: '127.0.0.1', port: smtp.server.address().port, security: 'none', user: 'm', password: 'p', from: 'Live Test <live@example.test>' }), 'email');
  node = await makeNode(admin, 'live-node', 'eu-west', { memoryMb: 65536, cpuPercent: 6400, diskMb: 2000000 });
  await heartbeat(admin, node);

  // --- Install, connect ----------------------------------------------------------------------------------------------
  ok(await call('POST', '/api/plugins', { source: 'bundled', id: 'stripe', acceptPermissions: true }), 'install');
  // The key below is a placeholder: the proxy ignores it and the CLI supplies the real credentials.
  ok(await call('PUT', '/api/plugins/stripe/settings', { secretKey: 'sk_test_viacli', webhookSecret: whsec }), 'plugin settings');
  ok(await call('PATCH', '/api/plugins/stripe', { enabled: true }), 'enable');
  const health = ok(await call('POST', '/api/plugins/stripe/health', {}), 'health');
  log('health: ' + health.message);
  check(health.ok === true && /test mode/.test(health.message), 'the plugin reaches the real Stripe and sees test mode');
  ok(await put('billing', { provider: 'stripe', currency: 'eur', currencies: ['eur'] }), 'provider');

  // --- Plans and a customer ---------------------------------------------------------------------------------------------------
  const plan = ok(await call('POST', '/api/plans', { name: 'Live 2 GB', kind: 'server', preset: { templateId: 'minecraft-java', memoryMb: 2048, cpuPercent: 100, diskMb: 10240 }, perCustomerMax: 5,
    prices: [{ cycle: 'month', amount: 800, currency: 'eur' }, { cycle: 'year', amount: 8000, currency: 'eur', trialDays: 7 }] }), 'plan');
  const big = ok(await call('POST', '/api/plans', { name: 'Live 4 GB', kind: 'server', preset: { templateId: 'minecraft-java', memoryMb: 4096, cpuPercent: 200, diskMb: 20480 }, prices: [{ cycle: 'month', amount: 1500, currency: 'eur' }] }), 'plan 2');
  ok(await put('store', { enabled: true, termsUrl: 'https://example.test/terms', privacyUrl: 'https://example.test/privacy', companyName: 'Live Test Ltd', companyEmail: 'billing@example.test', requireTerms: true }), 'store');
  const readiness = ok(await call('GET', '/api/billing/readiness'), 'readiness');
  check(readiness.checks.find((c) => c.id === 'connection').ok, 'readiness agrees');

  const cust = ok(await call('POST', '/api/customers', { email: `live-${rid()}@example.test` }), 'customer');
  const buyer = client(stack.base);
  ok(await buyer.call('POST', '/api/auth/login', { email: cust.email, password: cust.temporaryPassword }), 'login');

  // --- 1. A real Checkout Session ----------------------------------------------------------------------------------------------------
  const co = ok(await buyer.call('POST', '/api/store/checkout', { planId: plan.id, cycle: 'year', acceptTerms: true, name: 'Live server' }), 'checkout');
  log('checkout page: ' + co.url.slice(0, 60) + '…');
  check(/^https:\/\/checkout\.stripe\.com\//.test(co.url), 'Stripe hands back its hosted payment page');
  const order = (await q('SELECT * FROM orders WHERE id=$1', [co.orderId]))[0];
  const session = await stripe('get', `/v1/checkout/sessions/${order.provider_session_id}`);
  check(session.client_reference_id === co.orderId && session.mode === 'subscription' && session.status === 'open', 'the session carries our order id and is open');
  const items = await stripe('get', `/v1/checkout/sessions/${session.id}/line_items`);
  const li = items.data[0];
  check(li.price.unit_amount === 8000 && li.price.currency === 'eur' && li.price.recurring.interval === 'year', 'the price is the one from the database, billed yearly');
  check(session.subscription_data?.trial_period_days === 7 || session.metadata?.fledge_order === co.orderId, 'the trial or order marker travels with it');
  // The customer walks away: the session expires and the order with it.
  await stripe('post', `/v1/checkout/sessions/${session.id}/expire`);
  await until(async () => (await q('SELECT status FROM orders WHERE id=$1', [co.orderId]))[0].status === 'expired', 'the expired session to reach the order');
  check(true, 'an expired checkout expires the order (real signed webhook)');
  const events = await q("SELECT type,processed_at FROM billing_events WHERE type LIKE 'checkout.%'");
  check(events.length >= 1 && events.every((e) => e.processed_at), 'the webhook came from Stripe, passed the signature check and was processed');

  // --- 2. A real subscription on a test clock (stands in for a finished checkout) ----------------------------------------------------
  const start = Math.floor(Date.now() / 1000);
  const clock = await stripe('post', '/v1/test_helpers/test_clocks', { frozen_time: start, name: 'fledge-live-' + rid() });
  const customer = await stripe('post', '/v1/customers', { email: cust.email, test_clock: clock.id, 'metadata[fledge_user]': cust.id });
  const good = await stripe('post', '/v1/payment_methods/pm_card_visa/attach', { customer: customer.id });
  await stripe('post', `/v1/customers/${customer.id}`, { 'invoice_settings[default_payment_method]': good.id });
  const product = await stripe('post', '/v1/products', { name: 'Live 2 GB' });
  // The order that a finished checkout would have left behind.
  const price = (await q('SELECT * FROM plan_prices WHERE plan_id=$1 AND cycle=$2 AND active', [plan.id, 'month']))[0];
  const orderId = (await q(`INSERT INTO orders(user_id,plan_id,price_id,status,snapshot,details,provider,livemode) VALUES($1,$2,$3,'pending',$4,$5,'stripe',false) RETURNING id`,
    [cust.id, plan.id, price.id, JSON.stringify({ planName: plan.name, kind: 'server', cycle: 'month', amount: 800, currency: 'eur', trialDays: 0, setupFee: 0 }), JSON.stringify({ name: 'Clock server' })]))[0].id;
  const sub = await stripe('post', '/v1/subscriptions', { customer: customer.id, 'items[0][price_data][currency]': 'eur', 'items[0][price_data][product]': product.id, 'items[0][price_data][unit_amount]': 800,
    'items[0][price_data][recurring][interval]': 'month', 'metadata[fledge_order]': orderId, 'metadata[fledge_user]': cust.id });
  log(`subscription ${sub.id} is ${sub.status}`);
  // Events can arrive before Fledge knows the subscription: they wait and retry. Then the "checkout" completes locally.
  await sleep(2500);
  const localId = (await q(`INSERT INTO subscriptions(user_id,plan_id,price_id,order_id,provider,provider_subscription_id,provider_customer_id,livemode,status,cycle,amount,currency,fulfilment,server_details)
    VALUES($1,$2,$3,$4,'stripe',$5,$6,false,'incomplete','month',800,'eur','pending',$7) RETURNING id`, [cust.id, plan.id, price.id, orderId, sub.id, customer.id, JSON.stringify({ name: 'Clock server' })]))[0].id;
  await q("UPDATE orders SET status='paid',subscription_id=$2 WHERE id=$1", [orderId, localId]);
  ok(await call('POST', `/api/billing/admin/subscriptions/${localId}/sync`, {}), 'sync');
  const s1 = await subRow(localId);
  check(s1.status === 'active' && s1.provider_status === 'active' && Number(s1.amount) === 800 && s1.currency === 'eur' && s1.current_period_end, 'the real subscription is read: active, €8.00, with its period');
  check(Math.abs(new Date(s1.current_period_end).getTime() / 1000 - (start + 30 * 86400)) < 3 * 86400, 'the billing period is a month long (test clock time)');
  await until(async () => (await subRow(localId)).fulfilment === 'done', 'the server');
  check(!!(await q('SELECT id FROM servers WHERE subscription_id=$1', [localId]))[0], 'the paid subscription gets its server');
  await jobs();
  const inv = await until(async () => (await q('SELECT * FROM invoices WHERE subscription_id=$1', [localId]))[0], 'the first invoice');
  check(inv.status === 'paid' && Number(inv.amount_paid) === 800 && inv.hosted_url && inv.number, 'the first invoice is mirrored with its hosted address and number');
  await until(() => mailTo(cust.email, /Receipt for/)[0], 'the receipt');
  check(true, 'and the receipt email went out');

  // --- 3. A normal renewal (the clock advances a month) -------------------------------------------------------------------------------
  await advance(clock.id, start + 33 * 86400);
  await until(async () => (await q('SELECT count(*)::int n FROM invoices WHERE subscription_id=$1', [localId]))[0].n >= 2, 'the renewal invoice', 90000);
  check(true, 'a renewal creates a second paid invoice in Fledge (from the real invoice.paid event)');
  check((await subRow(localId)).status === 'active', 'and the subscription stays active');

  // --- 4. The card stops working, then is fixed --------------------------------------------------------------------------------------------
  const bad = await stripe('post', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: customer.id });
  await stripe('post', `/v1/customers/${customer.id}`, { 'invoice_settings[default_payment_method]': bad.id });
  await stripe('post', `/v1/subscriptions/${sub.id}`, { default_payment_method: bad.id });
  await advance(clock.id, start + 66 * 86400);
  await until(async () => (await subRow(localId)).status === 'past_due', 'past due after a failed renewal', 120000);
  check((await subRow(localId)).past_due_since !== null, 'a failed renewal puts the subscription past due');
  await until(() => mailTo(cust.email, /payment for Live 2 GB failed/)[0], 'the dunning email');
  check(true, 'the customer is told');
  const open = (await q("SELECT provider_invoice_id FROM invoices WHERE subscription_id=$1 AND status='open'", [localId]))[0];
  check(!!open, 'the open invoice is mirrored');
  await stripe('post', `/v1/customers/${customer.id}`, { 'invoice_settings[default_payment_method]': good.id });
  await stripe('post', `/v1/subscriptions/${sub.id}`, { default_payment_method: good.id });
  await stripe('post', `/v1/invoices/${open.provider_invoice_id}/pay`, { payment_method: good.id });
  await until(async () => (await subRow(localId)).status === 'active', 'active again after paying', 90000);
  check(true, 'paying the open invoice brings it back to active');

  // --- 5. Cancel and resume through Fledge, seen at Stripe ---------------------------------------------------------------------------------
  ok(await buyer.call('POST', `/api/billing/subscriptions/${localId}/cancel`, {}), 'cancel');
  check((await stripe('get', `/v1/subscriptions/${sub.id}`)).cancel_at_period_end === true, 'cancelling sets cancel_at_period_end at Stripe');
  ok(await buyer.call('POST', `/api/billing/subscriptions/${localId}/resume`, {}), 'resume');
  check((await stripe('get', `/v1/subscriptions/${sub.id}`)).cancel_at_period_end === false, 'resuming clears it');

  // --- 6. Changing plan: a real proration at Stripe ----------------------------------------------------------------------------------------------
  const cp = ok(await buyer.call('GET', `/api/billing/preview-change?subscriptionId=${localId}&planId=${big.id}&cycle=month`), 'preview');
  check(cp.to.plan === 'Live 4 GB' && cp.restart, 'the change is previewed');
  ok(await buyer.call('POST', `/api/billing/subscriptions/${localId}/change`, { planId: big.id, cycle: 'month' }), 'change plan');
  const changed = await stripe('get', `/v1/subscriptions/${sub.id}`);
  check(changed.items.data[0].price.unit_amount === 1500, 'Stripe now bills €15.00');
  check((await q('SELECT memory_mb FROM servers WHERE subscription_id=$1 AND deleted_at IS NULL', [localId]))[0].memory_mb === 4096, 'and the server was resized');
  await jobs();

  // --- 7. Refund --------------------------------------------------------------------------------------------------------------------------------------------
  const paidInv = (await q("SELECT id,amount_paid,provider_invoice_id FROM invoices WHERE subscription_id=$1 AND status='paid' AND amount_paid>0 ORDER BY created_at LIMIT 1", [localId]))[0];
  ok(await call('POST', `/api/billing/admin/subscriptions/${localId}/refund`, { invoiceId: paidInv.id, amount: 300 }), 'refund');
  const charge = await stripe('get', `/v1/invoices/${paidInv.provider_invoice_id}`, { 'expand[]': 'charge' });
  check(charge.charge.amount_refunded === 300, 'a real partial refund was made');
  await until(async () => Number((await q('SELECT amount_refunded FROM invoices WHERE id=$1', [paidInv.id]))[0].amount_refunded) === 300, 'the refund in Fledge');
  await until(() => mailTo(cust.email, /Refund of/)[0], 'the refund mail');
  check(true, 'the refund shows on the invoice and the customer is emailed');

  // --- 8. The customer portal -----------------------------------------------------------------------------------------------------------------------------
  await q("INSERT INTO billing_customers(user_id,provider,livemode,provider_customer_id) VALUES($1,'stripe',false,$2) ON CONFLICT DO NOTHING", [cust.id, customer.id]);
  const portal = ok(await buyer.call('POST', '/api/billing/portal', {}), 'portal');
  check(/^https:\/\/billing\.stripe\.com\//.test(portal.url), 'the portal address comes back (the plugin creates the portal settings when Stripe has none)');

  // --- 9. The end: the period passes after cancelling -------------------------------------------------------------------------------------------
  ok(await buyer.call('POST', `/api/billing/subscriptions/${localId}/cancel`, {}), 'cancel again');
  await advance(clock.id, start + 120 * 86400);
  await until(async () => (await subRow(localId)).status === 'canceled', 'the end of the subscription', 120000);
  const end = await subRow(localId);
  check(end.retention_until && (await q('SELECT suspended_reason FROM servers WHERE subscription_id=$1 AND deleted_at IS NULL', [localId]))[0].suspended_reason === 'billing', 'Stripe ends it; Fledge stops the server and keeps the data');
  await until(() => mailTo(cust.email, /has ended/)[0], 'the ended mail');

  // --- Housekeeping ----------------------------------------------------------------------------------------------------------------------------------------------
  await until(async () => (await q('SELECT count(*)::int n FROM billing_events WHERE processed_at IS NULL'))[0].n === 0, 'the inbox to drain', 120000);
  check(true, 'every event that Stripe sent was processed');
  const errs = await q('SELECT type,error FROM billing_events WHERE error IS NOT NULL AND processed_at IS NULL');
  check(errs.length === 0, 'and none is stuck');
  await stripe('delete', `/v1/test_helpers/test_clocks/${clock.id}`).catch(() => {});
  console.log(`PASS ${admin.state.count} live checks against the real Stripe API (test mode, sandbox via the CLI)`);
} catch (e) {
  failed = e;
  console.error('FAIL', e.message);
  console.error(String(e.stack).split('\n').filter((l) => l.includes('stripe-live')).slice(0, 2).join('\n'));
  try { console.error('--- billing events ---', JSON.stringify(await q('SELECT type,error,attempts,processed_at IS NOT NULL AS done FROM billing_events ORDER BY id DESC LIMIT 8'))); } catch { /* ignore */ }
  console.error('--- api log tail ---'); console.error(stack.api.logs().split('\n').slice(-20).join('\n'));
  console.error('--- calls Stripe refused ---'); console.error(proxyErrors.slice(-5).join('\n'));
  try { console.error('--- last order errors ---', JSON.stringify(await q('SELECT status,error FROM orders ORDER BY created_at DESC LIMIT 3'))); } catch { /* ignore */ }
  console.error('--- stripe listen tail ---'); console.error(listenerLog.replace(/whsec_[A-Za-z0-9]+/g, 'whsec_(hidden)').split('\n').slice(-8).join('\n'));
}
listener.kill();
await stack.stop();
smtp.close();
proxy.close();
process.exit(failed ? 1 : 0);
