# Stripe Payments

Turns on paid plans in Fledge using [Stripe](https://stripe.com).

**How it works.** Customers pay on Stripe's own pages (Checkout and the customer portal); card details never touch Fledge. Fledge creates the price at checkout, so there are no products or prices to set up in Stripe. Stripe tells Fledge about payments through a signed webhook, and Fledge always asks Stripe for the current state before acting on an event.

**Set up (test mode first)**

1. In the Stripe dashboard, turn on *Test mode* and copy a secret key (`sk_test_...`).
2. Enable this plugin and paste the key into its settings.
3. Add a webhook endpoint pointing at `https://<your panel>/api/billing/webhooks/stripe` for these events: `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.*`, `invoice.*`, `charge.refunded`, `charge.dispute.*`. Paste its signing secret (`whsec_...`) into the plugin.
   Locally, `stripe listen --forward-to localhost:4000/api/billing/webhooks/stripe` prints a signing secret to use.
4. Choose *Stripe* in Settings, Billing, then run the health check.

**Permissions:** reach `api.stripe.com`; take payments and manage subscriptions; keep a small private store (the id of the billing portal configuration it creates).

**Test cards:** `4242 4242 4242 4242` succeeds, `4000 0000 0000 0341` attaches but fails the next payment, `4000 0025 0000 3155` asks for 3-D Secure.
