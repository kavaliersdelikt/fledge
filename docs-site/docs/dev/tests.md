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
npm run test:unit        # pure functions: manifests, quotas, cron, CIDR, regex safety, address checks...
npm run test:cors
npm run test:updates
npm run test:templates   # Pterodactyl egg conversion
npm run test:plugins     # plugin system end to end + trust and hostile-plugin cases + pack tool
npm run test:templates-v2
npm run test:fit         # quotas, extra ports, clone
npm run test:autopilot   # schedules, crash policy, notifications, metrics
npm run test:accounts    # sessions, invitations, passkeys, allow-list, audit, OpenAPI
node --import tsx test/smoke.mjs   # the original end-to-end smoke test (needs a running API, see below)
```

The suites share `api/test/harness.mjs` (boots the stack, client with cookie jar, fake node helpers), `modrinth-mock.mjs`
(a mock of the Modrinth API), `authenticator.mjs` (a software WebAuthn authenticator), and use an SMTP test server.

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
npx tsx --test src/lib/*.test.ts
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
