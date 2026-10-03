---
title: Tests
---

# Tests

Integration suites create their own throw-away databases and start real API and plugin host processes. Point them at a PostgreSQL
superuser connection:

```sh
export TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
```

## API

```sh
cd api
npm ci
npm run check            # tsc --noEmit
npm run test:unit        # pure functions: manifests, quotas, cron, CIDR, regex safety, address checks... and the theme engine (shared/theme.test.ts)
npm run test:cors
npm run test:updates
npm run test:templates   # Pterodactyl egg conversion
npm run test:plugins     # plugin system end to end + trust and hostile-plugin cases + pack tool
npm run test:templates-v2
npm run test:fit         # quotas, extra ports, clone
npm run test:autopilot   # schedules, crash policy, notifications, metrics
npm run test:accounts    # sessions, invitations, passkeys, allow-list, audit, OpenAPI
npm run test:branding    # appearance: CSS and image checks, public document, history, emails, kill switch
npm run test:rookery     # sign-up, limits, self-service servers, email templates and outbox (unit tests and an end-to-end suite)
npm run test:billing     # plans, the store, checkout, webhooks, subscriptions, dunning, refunds, disputes (against a signed Stripe stand-in)
node --import tsx test/stripe-live.mjs   # by hand: the same plugin against the REAL Stripe test mode through the Stripe CLI (see below)
node --import tsx test/smoke.mjs   # the original end-to-end smoke test (needs a running API, see below)
```

The suites share `api/test/harness.mjs` (boots the stack, client with cookie jar, fake node helpers), `modrinth-mock.mjs`
(a mock of the Modrinth API), `authenticator.mjs` (a software WebAuthn authenticator), and use an SMTP test server.

`api/test/stripe-mock.mjs` is a small Stripe stand-in with controls that play the customer and send correctly signed webhooks. `api/test/stripe-live.mjs` runs the bundled Stripe plugin against the real
Stripe API in **test mode** with the [Stripe CLI](https://docs.stripe.com/stripe-cli) you are logged in with. It never reads your API key: the plugin's calls are redirected to a local proxy that performs each one with
`stripe get|post|delete`, webhooks come from `stripe listen`, and renewals and failures are driven with Stripe test clocks and test payment methods. The one step it cannot do is the customer paying on Stripe's hosted page.

The legacy smoke test expects an API already running on port 4172 against an empty database (`TEST_API_URL`).

## Plugin host

```sh
cd plugins/host && npm ci && npm run check && npm test    # sandbox isolation, limits, network rules
cd ../tools && npm ci                                     # the pack tool's dependency
```

## Panel

```sh
cd web
npm ci
npm run check
npx tsx --test src/lib/*.test.ts   # includes css-tokens.test.ts, which fails on a fixed font size, radius or colour in the stylesheets
npm run build
```

## Agent

```sh
cd agent
go vet ./... && go test ./... && go build ./...
```

Needs Linux; on other systems use `golang:1.25` in Docker (see [Run from source](/dev/run-from-source)).

## Scripts

```sh
sh tests/install-smoke.sh
sh tests/update-smoke.sh
sh tests/update-flow-smoke.sh
sh tests/connector-smoke.sh
sh tests/release-build-smoke.sh
```

They run the real scripts against stubbed Docker and Git. PowerShell variants live next to them (`*.ps1`).

## Docs

```sh
cd docs-site
npm ci
npm run examples        # runs the tutorial plugin in the real sandbox
npm run build           # generates the references and builds the site
npm run check           # link, code-block and coverage checks
```

## CI

`.github/workflows/ci.yml` runs all of the above on every push and pull request, plus a Compose job that builds and starts the stack
and checks the plugin host is healthy, hardened and unpublished.

## Look and feel regression

Changing the stylesheets? `docs-site/screenshots/regress.mjs` records the computed style of every element on every screen of a
seeded demo and compares two recordings, so a refactor that should not change the look can prove it:

```sh
node screenshots/regress.mjs record before.json    # build the panel for the demo API first (see screenshots/README.md)
# ... change the CSS, rebuild ...
node screenshots/regress.mjs record after.json
node screenshots/regress.mjs compare before.json after.json
```
