---
title: "Selling servers: going live"
---

# Selling servers: going live

This is the path from "Fledge for friends" to "Fledge as a hosting business". Do it in test mode first; every step below works with test money.

## 1. Decide what you sell

Plan on paper before touching the panel:

- **Fixed servers** ("Minecraft 4 GB, €15 a month"): [server plans](/panel/plans). The customer chooses a plan, a name and a location. Simple to explain, simple to support.
- **Allowances** ("Creator: 5 servers, 16 GB for €5"): [account plans](/panel/plans) plus customers creating their own servers ([free choice](/panel/self-service)).
- **A free tier** to get people started: a free server plan, or defaults in [Limits](/panel/limits) with sign-up on.

Make sure you have **capacity**: plans whose server fits on no node show as sold out and cannot be bought.

## 2. Prepare the panel

1. [Email](/operate/email) with a real sender address (SPF/DKIM set up at your mail provider) and a **Reply-To** that someone reads. Use **Send a test email**.
2. [Backups](/operate/backups) on, because the final backup before any deletion needs object storage.
3. A public address with https ([reverse proxy](/operate/reverse-proxy)) so customers, and the payment provider's webhooks, can reach the panel.
4. [Appearance](/panel/appearance): your name and logo. Customers will see them in the sign-in page, the store and every email.
5. Your **terms**, **privacy policy** and, where it applies, an **imprint**, published on your website. Decide your refund rules.

## 3. Payments in test mode

1. Install the [Stripe plugin](/plugins/stripe), paste a **test** key and webhook secret, and choose it in Settings → Billing.
2. Create your plans. Buy each one yourself as a customer (create a customer account for it) with the test card `4242 4242 4242 4242` and see the server appear.
3. Use Stripe's test clocks or `4000 0000 0000 0341` to see a failed renewal: the email, the overdue banner, the suspension after your chosen days, and the server starting again after you fix the payment.
4. Cancel and resume. Change plan. Refund an invoice.
5. Read the emails (Settings → Email templates → *Send me a test*) and adjust the words.
6. Check **Billing → Health**: the provider answers, events are processed, nothing is stuck.

## 4. Open to the public

1. Decide on [sign-up](/panel/signup): *open* with a bot check, or *with approval* while you are small. Turn on the terms checkbox and set the version.
2. Set [limits](/panel/limits) for free users, in warn mode first if you are unsure.
3. [Self-service](/panel/self-service): release only the templates you can support.
4. Fill in [the store](/panel/store): company name, address, support email and the withdrawal and tax notes. Then **Open the store**.

## 5. Switch to live money

1. In the provider, complete the account's business details, then create **live** credentials: a live secret key and a live webhook endpoint with the same events.
2. Put them into the plugin, run **Billing → Health → Check now** and make sure it says **Live: real money**.
3. Remove test records (Health → *Remove test-mode records*): delete the servers that belong to test subscriptions first.
4. Make one real purchase with a small plan and refund it. Check the receipt, the invoice, the server and the refund email.
5. Tell yourself how you will notice trouble: set a copy address for billing alerts under Email, and add a notification channel for *A paid server could not be created*, *A customer's payment failed* and *Billing needs attention*
   (Settings → Notifications).

## 6. Running it

- Look at **Billing → Overview** and **Health** once a day to start with. Overdue payments, disputes and servers that could not be created also arrive as notifications.
- Cancelled servers wait for you unless you turned automatic deletion on; look at them monthly.
- Keep the panel [updated](/operate/updating). Read the release notes before updating: billing changes are called out.
- Back up the database. Subscriptions, orders and invoices live there.

## What Fledge does not do for you

Fledge does not calculate tax, file returns, or decide what consumer law requires where you sell. It does not issue its own invoices: it shows and links the payment provider's. It has no usage-based billing,
prepaid credit or reseller features, and no providers other than Stripe yet (the [payments contract](/plugins/payments) allows more). You are responsible for your terms, your prices and your compliance.
