---
title: Recovering from billing problems
---

# Recovering from billing problems

Billing is built so that a failure stops *selling*, not *running*: servers keep running, customers keep their data, and the rest of the panel is unaffected. Here is what each problem looks like and how to fix it.
Start at **Billing → Health**; it lists what needs attention.

## Payments arrive but nothing happens in the panel

The provider cannot reach the webhook, or the signature does not match.

1. **Billing → Health** shows "Last event: None yet" or an old time. Copy the **webhook address** shown there into the provider's dashboard.
2. The signing secret in the plugin must be the one of *that* endpoint (with `stripe listen`, the secret it prints). Test and live endpoints have different secrets.
3. The panel must be reachable by the provider over https. Check your [reverse proxy](/operate/reverse-proxy) passes `/api/billing/webhooks/` to the API untouched (it needs the original body).
4. Nothing is lost meanwhile: the scheduled check (every 15 minutes) and the customer's return page both fetch the real state from the provider. Use **Check with provider** on a subscription to do it right now.

## An event is stuck "Failing"

Under Health → recent events, an event shows the error and the number of attempts. Events are retried with growing pauses for up to 20 attempts. Fix the cause (usually the provider key, or the provider being
unreachable), then **Process again**. Events for subscriptions that did not come from Fledge are ignored on purpose.

## "Payments are not available right now"

The chosen provider is switched off, its key was rejected, or its health check fails. **Health → Check now** shows the provider's own message. While this is the case the store pauses, but servers, billing pages and existing
subscriptions keep working. A bad key is changed in the plugin's settings.

## A customer paid but has no server

Open the subscription: **Server: Not created yet**. The reason (usually "no capacity") is shown, the customer was told, and Fledge retries by itself for 24 hours. Add capacity (or free some), then **Try again**.
If you cannot serve them, **Refund and cancel**. Billing health lists such subscriptions.

## A server stays stopped after the customer paid

- The subscription still says *Payment overdue* or *Suspended*: **Check with provider**. If the provider says paid, it becomes active and the server starts.
- A **hold** is on it (an administrator's, or a dispute): **Release hold** on the subscription.
- The server was suspended by an administrator: payment never lifts that. Unsuspend it from the server's settings.

## Test and live records are mixed

The store will not open while subscriptions from the other mode exist, and the checklist says so. Switch the keys back, or, with the provider in live mode, **Health → Remove test-mode records** (delete the test servers first).

## A refund or dispute does not show

Refunds appear on the invoice when the provider's event arrives or at the next scheduled check. **Check with provider** forces it. A dispute stops the server (if that setting is on) until it is won or lost.

## A price was wrong

Prices are never edited in place. Fix the price on the plan; new customers get the new price and existing subscribers keep theirs. To change what existing subscribers pay, change their subscription at the provider
or move them to another plan.

## Email is not arriving

**Settings → Email templates → Delivery log** shows every message with its status and the last error. Failed ones can be tried again. Receipts and reminders are retried with growing pauses for a week at most.

## Starting over

Switch **Open the store** off: customers lose the Store page, existing subscriptions continue. To remove a payment provider, choose *None* in Settings → Billing; subscriptions stay as they are but nothing new can be bought and
nothing is read from the provider.
