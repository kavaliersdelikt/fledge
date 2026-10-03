---
title: The payments contract
---

# The payments contract

A plugin can be a **payment provider**. Fledge owns everything about selling (orders, subscriptions, entitlements, servers, emails, the interface); the plugin only translates between that and one provider such as
Stripe. This page is for people writing such a plugin. For using one, see [the Stripe plugin](/plugins/stripe).

## Declaring it

```json
{
  "id": "stripe", "name": "Stripe Payments", "version": "1.0.0", "apiVersion": 1,
  "permissions": ["network:api.stripe.com", "payments", "storage"],
  "payments": {
    "id": "stripe",
    "label": "Stripe",
    "intervals": ["month", "quarter", "semiannual", "year"],
    "currencies": [],
    "features": ["checkout", "portal", "refund", "trial", "tax", "coupons", "change"]
  }
}
```

- The new permission **`payments`** is shown to the administrator as "Take payments and manage subscriptions through this provider. It sees order details and customers' email addresses, and holds your API keys".
- `payments.id` is what the provider is called in the webhook address (`/api/billing/webhooks/<id>`). `checkout` is required; `currencies: []` means any.
- A plugin needs `payments` if and only if it declares `payments`. `apiVersion` stays `1`: the contract is additive.
- Settings (keys, webhook secrets) use the normal `secret` fields. They reach only your plugin.

The administrator chooses the active provider in Settings → Billing. Only a plugin that is switched on and holds the permission can be chosen.

## What you implement

All methods are async functions on `globalThis.fledgePlugin`, run in the [sandbox](/plugins/security). They receive and return plain data; dates are ISO strings, amounts are integers in the currency's
smallest unit. The core never trusts an amount from a plugin: it compares with its own records.

| Method | Input | Returns |
| --- | --- | --- |
| `healthCheck()` | | `{ ok, message, livemode, account }` |
| `createCheckout(input)` | `{ order: {id, planName, description, cycle, amount, currency, trialDays, setupFee}, customer: {userId, email, providerCustomerId}, urls: {success, cancel}, options: {automaticTax, collectAddress, collectTaxId, promoCodes} }` | `{ url, sessionId, customerId?, livemode }` |
| `createPortal(customerId, returnUrl)` | | `{ url }` |
| `reconcile(refs)` | `{ subscriptionId? , sessionId?, invoiceId? }` | `{ subscription?, session?, invoice? }`, the provider's current state, normalised (below) |
| `webhook(request)` | `{ body, headers }`: the raw body as text and the lower-cased headers | `{ ok, events: [...] }`. **Verify the signature here**; `ok: false` rejects the request |
| `cancel(subscriptionId, when)` | `when` is `"period_end"` or `"now"` | `{ ok }` |
| `resume(subscriptionId)` | | `{ ok }` |
| `changePlan(input)` | `{ subscriptionId, itemName, amount, currency, cycle, prorate }` | `{ ok }`. Throw if the change cannot be paid, so nothing is half-applied |
| `refund(invoiceId, amount?)` | | `{ ok, refundId }` |

Put the order id in the provider's metadata (`fledge_order`) when you create a checkout or subscription: Fledge uses it to tell its own subscriptions from others on the same account.

### Normalised objects

```ts
Subscription = { id, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, trialEnd, canceledAt, endedAt, amount, currency, customerId, latestInvoiceId, metadata, livemode }
  // status: incomplete | incomplete_expired | trialing | active | past_due | unpaid | canceled | paused
Invoice      = { id, subscriptionId, status, number, amountDue, amountPaid, amountRefunded, currency, periodStart, periodEnd, hostedUrl, pdfUrl, paidAt, description, attemptCount, livemode }
  // status: draft | open | paid | void | uncollectible
Session      = { id, status, paid, subscriptionId, customerId, orderId, livemode }   // status: open | complete | expired
WebhookEvent = { id, type, kind, livemode, refs: {sessionId?, subscriptionId?, invoiceId?, customerId?, disputeId?}, won? }
  // kind: checkout | subscription | invoice | refund | dispute_opened | dispute_closed | ignore
```

`kind` tells the core what to look at again; the core then calls `reconcile`. Return `ignore` (or no event) for anything else. A webhook is a nudge, not the truth.

## The core's side

- `POST /api/billing/webhooks/<id>` is public. It takes the raw body (at most 512 KB), rate limits it, hands it to your `webhook` method, stores each returned event once (unique per provider and event id), answers, and processes the
  events in the background with retries.
- Events about a subscription that Fledge does not know yet are retried for ten minutes when your metadata marks them as Fledge's, and ignored otherwise.
- Every 15 minutes (changeable), each unfinished subscription is compared with `reconcile`, so a lost webhook repairs itself.
- Records carry `livemode`; the store refuses to open while test and live records mix.

## Host helpers for payment plugins

| | |
| --- | --- |
| `host.crypto.hmacSha256(key, text)` | Hex HMAC-SHA256, for webhook signatures |
| `host.crypto.sha256(text)`, `host.crypto.equals(a, b)`, `host.crypto.randomHex(n)` | A hash, a constant-time comparison, random bytes (at most 64) |
| `host.now()` | Milliseconds since 1970, for signature tolerance |
| `host.fetch(url, { method: "DELETE" })` | `DELETE` is now allowed next to `GET`, `HEAD` and `POST` |

The rest of the [host API](/plugins/host-api) and the [limits](/plugins/limits) apply unchanged.

## Testing

`api/test/stripe-mock.mjs` is a small stand-in for the Stripe API with controls that play the customer and send correctly signed webhooks; `api/test/billing-smoke.mjs` shows how a payment plugin is exercised end to
end against it. For a real provider, drive it in test mode as `api/test/stripe-live.mjs` does for Stripe.
