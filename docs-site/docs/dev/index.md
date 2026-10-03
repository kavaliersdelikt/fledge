---
title: Repository layout
---

# Development

Fledge is a monorepo. Everything is plain TypeScript, Go and SQL with few dependencies.

```text
api/              Fastify API (TypeScript, run with tsx). src/ routes and modules, test/ suites
web/              Next.js 15 / React 19 panel
agent/            Linux node agent (Go)
plugins/
  host/           Plugin host: QuickJS-WASM sandbox + HTTP server (TypeScript)
  bundled/        The two Modrinth plugins and their shared client
  tools/          pack.mjs: build, sign, index and verify plugin packages
  registry/       The default plugin registry index
shared/           Code used by both the API and the panel: the theme engine (shared/theme.ts) and its tests
db/schema.sql     The whole database schema, applied idempotently at API start
compose.yaml      The stack: postgres, api, web, plugins, updater, optional s3
install.* update.*  Installers and updaters (shell and PowerShell)
tests/            Shell smoke tests for the scripts
docs/             Release notes and plans (and plugin docs redirects)
docs-site/        This documentation site
.github/workflows CI and the release workflow
```

## Key modules in `api/src`

| Module | Responsibility |
| --- | --- |
| `index.ts` | Wiring: registers routes, background sweeps, security headers |
| `core.ts` | Database pool, auth middleware, helpers (`fail`, `audit`, `enqueue`, `serverAccess`) |
| `auth.ts`, `accounts.ts` | Sign-in, 2FA, passkeys, sessions, invitations and resets |
| `servers.ts`, `ports.ts`, `clone.ts` | Server lifecycle, backups, extra ports, clone |
| `agent.ts` | The node protocol: enrol, heartbeat, jobs, results |
| `failover.ts`, `recovery.ts`, `backup-maintenance.ts`, `verification.ts` | Resilience |
| `automation.ts`, `crash.ts`, `notifications.ts`, `metrics.ts` | Autopilot |
| `templates.ts`, `quota.ts` | Templates v2 and quotas |
| `addons.ts`, `plugins/*` | The plugin system and the add-on installer |
| `settings.ts`, `storage.ts`, `mailer.ts`, `netguard.ts`, `netpolicy.ts` | Settings, object storage, email, outbound-request guard, allow-list |
| `branding.ts` | Appearance: the document, validation, images, history, custom CSS checks, the public projection (colour maths is in `shared/theme.ts`) |
| `openapi.ts` | Generates the OpenAPI description from the registered routes |

## Conventions

- The API code is deliberately compact; match the surrounding style, comment density and naming.
- Schema changes are **additive** in `db/schema.sql` (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`); never drop or rewrite.
- Every new route should be registered where `index.ts` registers the others and should get an entry in `openapi.ts` (see
  [Adding an API route](/dev/adding-routes)).
- Security-relevant input handling goes through `core.ts` helpers (`txt`, `positive`, `asId`, `fail`) and, for outbound requests,
  `netguard.ts`.
- Everything a customer can reach must go through `serverAccess` or an explicit role check.
- Keep the agent Linux-only; use `golang:1.25` in Docker for tests on other platforms.

Next: [Run from source](/dev/run-from-source), [Tests](/dev/tests).
