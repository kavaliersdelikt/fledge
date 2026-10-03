// Stripe Payments for Fledge. Runs inside the plugin sandbox: no Node, no timers; the only way
// out is `host`. Implements the payments contract (see api/src/billing/provider.ts).
//
// Design rules:
//  - Prices are created at checkout (price_data), so nothing has to be synced with Stripe.
//  - A webhook is only a nudge. `webhook` verifies the signature and classifies the event;
//    Fledge then calls `reconcile` to read the real objects.
//  - Nothing here decides what a customer owes. Amounts come from Fledge's order snapshot.
(function () {
  var API = 'https://api.stripe.com';
  var CYCLES = { month: { interval: 'month', count: 1 }, quarter: { interval: 'month', count: 3 }, semiannual: { interval: 'month', count: 6 }, year: { interval: 'year', count: 1 } };

  // ---- form encoding (Stripe takes application/x-www-form-urlencoded with bracket notation) ----
  function encode(obj, prefix, out) {
    Object.keys(obj).forEach(function (key) {
      var v = obj[key];
      if (v === undefined || v === null) return;
      var k = prefix ? prefix + '[' + key + ']' : key;
      if (Array.isArray(v)) {
        v.forEach(function (x, i) {
          if (x !== null && typeof x === 'object') encode(x, k + '[' + i + ']', out);
          else out.push(encodeURIComponent(k + '[' + i + ']') + '=' + encodeURIComponent(String(x)));
        });
      } else if (typeof v === 'object') encode(v, k, out);
      else out.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return out;
  }
  function form(obj) { return encode(obj || {}, '', []).join('&'); }

  function taxCode() { return host.settings.taxCode || undefined; }
  function modeOf(key) { return /^(sk|rk)_live_/.test(String(key || '')); }
  function iso(sec) { return sec ? new Date(sec * 1000).toISOString() : null; }
  function id(x) { return x && typeof x === 'object' ? x.id : x || null; }

  // ---- HTTP ----
  async function api(method, path, params, opts) {
    var key = host.settings.secretKey;
    if (!key) throw new Error('The Stripe API key is not set.');
    var headers = { authorization: 'Bearer ' + key, 'stripe-version': host.settings.apiVersion || '2024-06-20', accept: 'application/json' };
    var url = API + path, body;
    var data = form(params);
    if (method === 'GET' || method === 'DELETE') { if (data) url += (url.indexOf('?') < 0 ? '?' : '&') + data; }
    else { headers['content-type'] = 'application/x-www-form-urlencoded'; body = data; }
    if (opts && opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    var r = await host.fetch(url, { method: method, headers: headers, body: body });
    var j;
    try { j = r.json(); } catch (e) { throw new Error('Stripe answered with something unexpected (HTTP ' + r.status + ')'); }
    if (!r.ok) {
      var err = (j && j.error) || {};
      var e2 = new Error('Stripe: ' + (err.message || 'request failed (HTTP ' + r.status + ')'));
      e2.stripeCode = err.code || err.type || '';
      e2.status = r.status;
      throw e2;
    }
    return j;
  }

  // ---- mapping ----
  function subscriptionSnapshot(s) {
    var amount = 0;
    ((s.items && s.items.data) || []).forEach(function (it) {
      if (it.price && it.price.recurring) amount += (it.price.unit_amount || 0) * (it.quantity || 1);
    });
    return {
      id: s.id, status: s.status,
      currentPeriodStart: iso(s.current_period_start), currentPeriodEnd: iso(s.current_period_end),
      cancelAtPeriodEnd: !!s.cancel_at_period_end || (!!s.cancel_at && s.cancel_at <= (s.current_period_end || 0)),
      trialEnd: iso(s.trial_end), canceledAt: iso(s.canceled_at), endedAt: iso(s.ended_at),
      amount: amount, currency: s.currency, customerId: id(s.customer), latestInvoiceId: id(s.latest_invoice),
      metadata: s.metadata || {}, livemode: !!s.livemode
    };
  }
  function invoiceSnapshot(i) {
    var charge = i.charge && typeof i.charge === 'object' ? i.charge : null;
    return {
      id: i.id, subscriptionId: id(i.subscription), customerId: id(i.customer), status: i.status,
      number: i.number || null, amountDue: i.amount_due || 0, amountPaid: i.amount_paid || 0,
      amountRefunded: charge ? (charge.amount_refunded || 0) : 0, currency: i.currency,
      periodStart: iso(i.period_start), periodEnd: iso(i.period_end),
      hostedUrl: i.hosted_invoice_url || null, pdfUrl: i.invoice_pdf || null,
      paidAt: iso(i.status_transitions && i.status_transitions.paid_at), description: i.description || null,
      attemptCount: i.attempt_count || 0, livemode: !!i.livemode
    };
  }

  // ---- the contract ----
  async function healthCheck() {
    var key = host.settings.secretKey;
    if (!key) return { ok: false, message: 'Enter the Stripe API key first.' };
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) return { ok: false, message: 'That does not look like a Stripe secret or restricted key (it should start with sk_ or rk_).' };
    if (!host.settings.webhookSecret) return { ok: false, message: 'Enter the webhook signing secret (whsec_...) too.', livemode: modeOf(key) };
    try {
      var acct = await api('GET', '/v1/account');
      var name = (acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name) || (acct.business_profile && acct.business_profile.name) || acct.id;
      return { ok: true, message: 'Connected to ' + name + (modeOf(key) ? ' (live mode)' : ' (test mode)'), livemode: modeOf(key), account: acct.id };
    } catch (e) {
      // Restricted keys may not read the account; a customer list is enough to prove the key works.
      if (e.status === 403 || /permission/i.test(e.message)) {
        try { await api('GET', '/v1/customers', { limit: 1 }); return { ok: true, message: 'Connected with a restricted key (' + (modeOf(key) ? 'live' : 'test') + ' mode)', livemode: modeOf(key) }; }
        catch (e2) { return { ok: false, message: e2.message, livemode: modeOf(key) }; }
      }
      return { ok: false, message: e.message, livemode: modeOf(key) };
    }
  }

  async function createCheckout(input) {
    var o = input.order, cu = input.customer, opt = input.options;
    var cycle = CYCLES[o.cycle];
    if (!cycle) throw new Error('Unsupported billing interval ' + o.cycle);
    var items = [{ quantity: 1, price_data: { currency: o.currency, unit_amount: o.amount, recurring: { interval: cycle.interval, interval_count: cycle.count }, product_data: { name: o.planName, description: o.description ? o.description.slice(0, 300) : undefined, tax_code: taxCode() } } }];
    if (o.setupFee > 0) items.push({ quantity: 1, price_data: { currency: o.currency, unit_amount: o.setupFee, product_data: { name: o.planName + ' (one-time setup)', tax_code: taxCode() } } });
    var params = {
      mode: 'subscription', client_reference_id: o.id, success_url: input.urls.success, cancel_url: input.urls.cancel,
      line_items: items,
      subscription_data: { metadata: { fledge_order: o.id, fledge_user: cu.userId }, trial_period_days: o.trialDays > 0 ? o.trialDays : undefined },
      metadata: { fledge_order: o.id }, allow_promotion_codes: opt.promoCodes ? 'true' : undefined,
      billing_address_collection: opt.collectAddress ? 'required' : 'auto',
      tax_id_collection: opt.collectTaxId ? { enabled: 'true' } : undefined,
      automatic_tax: opt.automaticTax ? { enabled: 'true' } : undefined,
      payment_method_collection: 'always', locale: 'auto',
      // Fledge calculates entitlement itself and reads subscriptions in the pinned API version, so Stripe's Managed Payments
      // (Stripe as seller of record, newer API versions only) is switched off for these sessions.
      managed_payments: { enabled: 'false' }
    };
    if (cu.providerCustomerId) {
      params.customer = cu.providerCustomerId;
      if (opt.automaticTax || opt.collectTaxId) params.customer_update = { address: 'auto', name: 'auto' };
    } else params.customer_email = cu.email;
    var s = await api('POST', '/v1/checkout/sessions', params, { idempotencyKey: 'fledge-order-' + o.id });
    return { url: s.url, sessionId: s.id, customerId: id(s.customer), livemode: !!s.livemode };
  }

  async function portalConfiguration() {
    var saved = host.storage.get('portalConfig');
    if (saved) return saved;
    var conf = await api('POST', '/v1/billing_portal/configurations', {
      business_profile: { headline: host.settings.portalHeadline || 'Manage your subscription' },
      features: {
        payment_method_update: { enabled: 'true' }, invoice_history: { enabled: 'true' },
        customer_update: { enabled: 'true', allowed_updates: ['email', 'name', 'address', 'tax_id'] },
        subscription_cancel: { enabled: 'true', mode: 'at_period_end' }
      }
    });
    host.storage.set('portalConfig', conf.id);
    return conf.id;
  }
  async function createPortal(customerId, returnUrl) {
    var params = { customer: customerId, return_url: returnUrl };
    try { var s = await api('POST', '/v1/billing_portal/sessions', params); return { url: s.url }; }
    catch (e) {
      // Stripe needs a portal configuration before the first session; create a sensible one once.
      if (!/configuration/i.test(e.message)) throw e;
      params.configuration = await portalConfiguration();
      var s2 = await api('POST', '/v1/billing_portal/sessions', params);
      return { url: s2.url };
    }
  }

  async function reconcile(refs) {
    var out = {};
    if (refs.subscriptionId) {
      var s = await api('GET', '/v1/subscriptions/' + encodeURIComponent(refs.subscriptionId), { expand: ['latest_invoice.charge'] });
      out.subscription = subscriptionSnapshot(s);
      if (s.latest_invoice && typeof s.latest_invoice === 'object') out.invoice = invoiceSnapshot(s.latest_invoice);
    }
    if (refs.sessionId) {
      var c = await api('GET', '/v1/checkout/sessions/' + encodeURIComponent(refs.sessionId));
      out.session = {
        id: c.id, status: c.status, paid: c.payment_status === 'paid' || c.payment_status === 'no_payment_required',
        subscriptionId: id(c.subscription), customerId: id(c.customer),
        orderId: c.client_reference_id || (c.metadata && c.metadata.fledge_order) || null, livemode: !!c.livemode
      };
    }
    if (refs.invoiceId) {
      var i = await api('GET', '/v1/invoices/' + encodeURIComponent(refs.invoiceId), { expand: ['charge'] });
      out.invoice = invoiceSnapshot(i);
    }
    return out;
  }

  function parseSignature(header) {
    var parts = String(header || '').split(','), t = null, v1 = [];
    parts.forEach(function (p) {
      var kv = p.trim().split('=');
      if (kv[0] === 't') t = kv[1]; else if (kv[0] === 'v1' && kv[1]) v1.push(kv[1]);
    });
    return { t: t, v1: v1 };
  }
  function signatureOk(body, header) {
    var sig = parseSignature(header);
    if (!sig.t || !sig.v1.length) return false;
    var age = Math.abs(host.now() / 1000 - Number(sig.t));
    if (!(age <= 300)) return false; // five minutes either way: blocks replays
    var secrets = String(host.settings.webhookSecret || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return secrets.some(function (secret) {
      var expected = host.crypto.hmacSha256(secret, sig.t + '.' + body);
      return sig.v1.some(function (v) { return host.crypto.equals(expected, v); });
    });
  }

  async function webhook(req) {
    if (!signatureOk(req.body, req.headers['stripe-signature'])) return { ok: false, error: 'bad signature', events: [] };
    var evt;
    try { evt = JSON.parse(req.body); } catch (e) { return { ok: false, error: 'bad payload', events: [] }; }
    var obj = (evt.data && evt.data.object) || {};
    var base = { id: evt.id, type: evt.type, livemode: !!evt.livemode };
    var t = evt.type, ev = null;
    if (/^checkout\.session\.(completed|expired|async_payment_succeeded|async_payment_failed)$/.test(t)) ev = { kind: 'checkout', refs: { sessionId: obj.id, subscriptionId: id(obj.subscription) || undefined } };
    else if (/^customer\.subscription\./.test(t)) ev = { kind: 'subscription', refs: { subscriptionId: obj.id } };
    else if (/^invoice\./.test(t) && obj.id) ev = { kind: 'invoice', refs: { invoiceId: obj.id, subscriptionId: id(obj.subscription) || undefined } };
    else if (t === 'charge.refunded' && obj.invoice) ev = { kind: 'refund', refs: { invoiceId: id(obj.invoice) } };
    else if (t === 'charge.dispute.created' || t === 'charge.dispute.closed') {
      var subId;
      try {
        var ch = await api('GET', '/v1/charges/' + encodeURIComponent(id(obj.charge)));
        if (ch.invoice) { var inv = await api('GET', '/v1/invoices/' + encodeURIComponent(id(ch.invoice))); subId = id(inv.subscription) || undefined; }
      } catch (e) { /* the dispute is still reported; Fledge ignores one it cannot match */ }
      ev = { kind: t === 'charge.dispute.created' ? 'dispute_opened' : 'dispute_closed', refs: { disputeId: obj.id, subscriptionId: subId }, won: t === 'charge.dispute.closed' ? obj.status === 'won' : undefined };
    }
    if (!ev) return { ok: true, events: [] };
    return { ok: true, events: [Object.assign({}, base, ev)] };
  }

  async function cancel(subscriptionId, when) {
    var path = '/v1/subscriptions/' + encodeURIComponent(subscriptionId);
    if (when === 'now') await api('DELETE', path, { invoice_now: 'false', prorate: 'false' });
    else await api('POST', path, { cancel_at_period_end: 'true' });
    return { ok: true };
  }
  async function resume(subscriptionId) {
    await api('POST', '/v1/subscriptions/' + encodeURIComponent(subscriptionId), { cancel_at_period_end: 'false' });
    return { ok: true };
  }

  async function productFor(name) {
    var key = 'product:' + host.crypto.sha256(name).slice(0, 24);
    var saved = host.storage.get(key);
    if (saved) return saved;
    var p = await api('POST', '/v1/products', { name: name, tax_code: taxCode() }, { idempotencyKey: 'fledge-' + key });
    host.storage.set(key, p.id);
    return p.id;
  }
  async function changePlan(input) {
    var cycle = CYCLES[input.cycle];
    if (!cycle) throw new Error('Unsupported billing interval ' + input.cycle);
    var s = await api('GET', '/v1/subscriptions/' + encodeURIComponent(input.subscriptionId));
    var item = s.items && s.items.data && s.items.data[0];
    if (!item) throw new Error('This subscription has no item to change.');
    var product = await productFor(input.itemName);
    await api('POST', '/v1/subscriptions/' + encodeURIComponent(input.subscriptionId), {
      items: [{ id: item.id, price_data: { currency: input.currency, product: product, unit_amount: input.amount, recurring: { interval: cycle.interval, interval_count: cycle.count } } }],
      proration_behavior: input.prorate ? 'create_prorations' : 'none',
      payment_behavior: 'error_if_incomplete', cancel_at_period_end: 'false'
    });
    return { ok: true };
  }

  async function refund(invoiceId, amount) {
    var inv = await api('GET', '/v1/invoices/' + encodeURIComponent(invoiceId), { expand: ['charge'] });
    var chargeId = id(inv.charge);
    if (!chargeId) throw new Error('This invoice has no payment to refund.');
    var r = await api('POST', '/v1/refunds', { charge: chargeId, amount: amount || undefined, reason: 'requested_by_customer' }, { idempotencyKey: 'fledge-refund-' + chargeId + '-' + (amount || 'all') });
    return { ok: true, refundId: r.id };
  }

  globalThis.fledgePlugin = {
    healthCheck: healthCheck, createCheckout: createCheckout, createPortal: createPortal, reconcile: reconcile,
    webhook: webhook, cancel: cancel, resume: resume, changePlan: changePlan, refund: refund
  };
})();
