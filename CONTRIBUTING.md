# Contributing to Fledge

Thanks for helping improve Fledge.

Fledge is a self-hosted game-server control panel with a TypeScript API and web panel, a Go node agent, a sandboxed plugin host, SQL schema, installers, and documentation. Contributions of code, tests, documentation, bug reports, and focused feature proposals are welcome.

## Before you start

For bugs, search the [existing issues](https://github.com/kavaliersdelikt/fledge/issues) first. When reporting a new bug, include clear reproduction steps, the expected and actual behaviour, and relevant logs.

For larger changes, open an issue before investing substantial work so the approach and scope can be discussed early.

Do **not** open a public issue for a security vulnerability. Report security issues privately through [GitHub Security Advisories](https://github.com/kavaliersdelikt/fledge/security/advisories/new) and read [SECURITY.md](SECURITY.md).

When sharing logs, screenshots, configuration, or test output, redact credentials, enrollment tokens, backup URLs, API keys, cookies, and other secrets.

By participating in the project, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository layout

Fledge is a monorepo. The main areas are:

- `api/` — Fastify API in TypeScript.
- `web/` — Next.js/React panel.
- `agent/` — Linux node agent in Go.
- `plugins/host/` — sandboxed plugin host.
- `plugins/bundled/` — bundled plugins.
- `plugins/tools/` — plugin packaging and verification tools.
- `shared/` — code shared by the API and panel.
- `db/schema.sql` — database schema.
- `tests/` — installer and updater smoke tests.
- `docs-site/` — documentation site sources.
- `.github/workflows/` — CI and release workflows.

See the [development documentation](https://kavaliersdelikt.github.io/fledge/dev/) for more detail.

## Development setup

Clone the repository:

```sh
git clone https://github.com/kavaliersdelikt/fledge.git
cd fledge
```

The TypeScript projects use Node.js 22 in CI. Install dependencies only in the part of the repository you are changing:

```sh
cd api && npm ci
cd ../web && npm ci
cd ../plugins/host && npm ci
```

The agent uses the Go version declared in `agent/go.mod`.

For a complete local stack, copy the example environment and start Docker Compose:

```sh
cp .env.example .env
docker compose up --build -d
```

Set the required local secrets in `.env` before starting the stack. Do not commit real secrets.

## Project conventions

Match the surrounding code style, naming, and comment density. Keep changes focused and avoid unrelated refactors.

Some repository-specific rules are especially important:

- Database schema changes in `db/schema.sql` must be additive and idempotent. Do not drop or rewrite existing schema objects.
- New API routes should be registered consistently with the existing routes and documented in `api/src/openapi.ts`.
- Security-sensitive API input should use the established validation and access-control helpers.
- Outbound requests from the API must follow the existing network-guarding approach.
- Customer-accessible functionality must use the established access checks or an explicit role check.
- Keep the node agent Linux-only unless the project direction changes explicitly.
- Update documentation when behaviour, configuration, API contracts, or operator workflows change.
- Add or update tests for bug fixes and behavioural changes whenever practical.

## Running checks

Run the checks relevant to the code you changed before opening a pull request.

### API

```sh
cd api
npm ci
npm run check
npm run test:unit
```

The API has additional focused suites for areas such as updates, plugins, templates, quotas, schedules, accounts, branding, billing, virtual machines, and usage reporting. See the [test documentation](https://kavaliersdelikt.github.io/fledge/dev/tests) and `.github/workflows/ci.yml` for the current CI matrix.

### Plugin host

```sh
cd plugins/host
npm ci
npm run check
npm test
```

### Web panel

```sh
cd web
npm ci
npm run check
npx tsx --test src/lib/*.test.ts
npm run build
```

### Node agent

```sh
cd agent
go vet ./...
go test ./...
go build ./...
```

For installer, updater, Compose, or cross-component changes, also run the relevant smoke tests or local stack checks described in the development documentation.

## Pull requests

Create a branch from the latest `main` and keep each pull request focused on one problem.

A useful pull request should:

- explain what changed and why;
- link the related issue when one exists;
- describe how the change was tested;
- call out migrations, security implications, compatibility concerns, or operator-facing changes;
- include screenshots for meaningful UI changes;
- update tests and documentation where needed.

Keep commits understandable and avoid committing generated files, local environment files, credentials, or unrelated formatting changes.

CI must pass before a change is ready to merge.

## Licensing

Fledge is licensed under the [GNU Affero General Public License v3.0 only](LICENSE.md). By contributing, you agree that your contribution may be distributed under the project license.
