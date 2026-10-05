# Documentation screenshots

`npm run screenshots` takes every screenshot used by the docs from a **demo stack with fictional data**: a real API and plugin host
against an empty throw-away database, the production build of the panel, and three simulated nodes. No real installation, customer
or credential is involved; the demo administrator (`maya@fledge.demo`) and every customer are made up.

## Run it

```sh
# prerequisites (once)
cd api && npm ci && cd ../plugins/host && npm ci
cd ../../web && npm ci && NEXT_PUBLIC_API_URL=http://localhost:4300 npm run build
cd ../docs-site && npm ci

# take them (needs PostgreSQL and a Chrome/Chromium)
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm run screenshots
ONLY=nodes,files npm run screenshots       # only some
CHROME_PATH=/usr/bin/chromium npm run screenshots
```

`NEXT_PUBLIC_API_URL` is compiled into the panel build, so build it with the demo API address (`http://localhost:4300`) before
running. The run needs internet access: the Modrinth plugins browse the real Modrinth catalog.

Files are written to `docs/public/screenshots/*.webp` (encoded by the browser, no extra tools). Failed shots leave
`_failed-<name>.png` next to them for inspection; delete these.

## Files

- `demo.mjs`: boots the stack and seeds the data (nodes, customers, servers, add-ons, schedules, notifications, history). The simulated agents
  heartbeat, answer jobs and stream console lines like real ones.
- `shots.mjs`: one function per screenshot. Wait for visible text rather than fixed times.
- `shots.appearance.mjs`: the appearance screenshots and the themed panels used on the landing page. They come last because they change the look of the whole demo panel; they use a fictional brand ("Lumen Hosting", logo in `assets/lumen-mark.svg`) and wait a few seconds after each change because the panel caches the appearance briefly.
- `run.mjs`: the runner (browser, sign-in, WebP encoding).
- `keep.mjs`: starts the same seeded demo and keeps it running (it writes the session cookie to `demo-session.json`), for looking around by hand.
- `regress.mjs`: records the computed style of every element on every screen and compares two recordings, to prove that a stylesheet refactor changes nothing (see [Tests](../docs/dev/tests.md)).

## Adding a screenshot

Add an entry to `shots.mjs`, run it with `ONLY=<name>`, look at the result, then reference it from a page with
`![Meaningful alt text](/screenshots/<name>.webp){.screenshot}`. `npm run check` fails for missing files or empty alt text.

When the UI changes noticeably, re-run the whole set and commit the new files.

## The hosting screenshots (0.7.1.1 "Rookery")

`rookery-demo.mjs` extends the demo with a fictional hosting business, *Willow Hosting*: a payment plugin talking to a **local stand-in for Stripe** (`api/test/stripe-mock.mjs`), a mail sink, four plans, customers at different points of
their subscription (a trial, a yearly plan, a late payment, a cancellation), and two people waiting to be approved. `shots.rookery.mjs` takes the screenshots of sign-up, the store, billing, limits and email templates from it. Take just those with
`ONLY=store,store-buy,billing-customer,self-service-create,billing-overview,billing-plans,billing-plan-editor,billing-subscription,billing-health,settings-signup,settings-self-service,settings-limits,settings-store,email-templates,customers-pending,limits-usage,stripe-plugin,signup-form npm run screenshots`.
`keep.rookery.mjs` keeps the same demo running for looking around by hand.

## Mews screenshots and browser checks

Run `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm run screenshots:mews` from `docs-site`. The runner builds the panel with its isolated API URL, then uses ports 3107 (panel), 4307 (API) and 4597 (plugin host), and the disposable `fledge_mews_docs_demo` database. It does not use an existing installation.

`mews-demo.mjs` seeds fictional team members, suspensions, tickets, articles and a mail sink. `run.mews.mjs` captures the shipped dark, light and mobile screens, and verifies suspension editing/lifting, customer and agent ticket replies, private-note isolation, solving, rating, reopening and automation editing. The public abuse check uses Cloudflare's published test keys through the real verification endpoint; it needs internet access and checks rejection without a bot response. These keys exist only in the disposable demo.

Successful runs write WebP documentation images and PNG inspection copies. Remove the PNG copies after visual review. Rebuild `web` with your normal `NEXT_PUBLIC_API_URL` after the screenshot run, because Next.js embeds that address in the build.

## Real VM screenshots

After completing implementation and the browser audit, regenerate the full existing set, then Mews and VM images. VM console images require an actual disposable guest: never draw a desktop or substitute simulated console output.

`vm-demo.mjs` imports the agent's real `vm.json` into the disposable documentation database. It reports software emulation truthfully, so this fixture is not KVM verification. Set `VM_MANIFEST` to that local manifest and `VM_RELAY_CONFIG` to a private, ignored JSON file accessible by your isolated relay harness. Run `npm run screenshots:mews`; it also takes Overview, desktop, serial, disks, network, installation, recovery, mobile, light-theme and administrator catalogue images. `capture.vm.mjs` requires a connected real guest framebuffer and verifies reconnect/fullscreen.

A disposable Docker harness can set `VM_RELAY_CONTAINER` and `VM_RELAY_SCRIPT` to start its bounded Linux relay script after the fixture writes fresh node credentials. Otherwise start the actual outbound relay yourself after seeding. Keep credentials out of screenshots, source control and public artifacts. Delete only the task's temporary manifests, relay files and inspection PNGs after review; retain the WebP images.

Run `npm run screenshots:vm` with the same real-guest environment variables to regenerate only the VM set; it builds the panel against its disposable fixture API before capture.
