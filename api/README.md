# Fledge API

A single-process TypeScript/Fastify control plane with PostgreSQL persistence. It is **beta**: not a completed commercial release.

Documentation: **<https://kavaliersdelikt.github.io/fledge/api/>**, including the generated
[endpoint reference](https://kavaliersdelikt.github.io/fledge/api/reference/), [authentication](https://kavaliersdelikt.github.io/fledge/api/authentication),
[conventions](https://kavaliersdelikt.github.io/fledge/api/conventions), the
[environment variables](https://kavaliersdelikt.github.io/fledge/reference/environment) and
[known gaps](https://kavaliersdelikt.github.io/fledge/guide/status). The API also serves its own OpenAPI description at `GET /api/openapi.json`
(administrators) and renders it in the panel under **API**.

## Run

Requires Node.js 22, PostgreSQL 15 or newer (a user allowed to create tables) and a 32-byte random encryption key. From `api/`:

```sh
npm ci
export DATABASE_URL='postgres://fledge:YOUR_PASSWORD@localhost:5432/fledge'
export ENCRYPTION_KEY="$(openssl rand -hex 32)"   # keep it; never regenerate after two-factor enrollment
export WEB_ORIGIN='http://localhost:3000'
export PORT=4000
npm start
```

`src/index.ts` applies the idempotent, additive `../db/schema.sql` at startup. **Back up PostgreSQL before upgrades.** Use TLS at a reverse
proxy and see [Reverse proxy and TLS](https://kavaliersdelikt.github.io/fledge/operate/reverse-proxy) (`TRUST_PROXY`, cookies, WebSockets).

## Checks

```sh
npm run check && npm run test:unit      # the integration suites need PostgreSQL: see the development docs
```

See [Tests](https://kavaliersdelikt.github.io/fledge/dev/tests) and [Adding an API route](https://kavaliersdelikt.github.io/fledge/dev/adding-routes).
