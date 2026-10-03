---
title: Authentication
---

# Authentication

## Sessions (browsers)

`POST /api/auth/login` with `{ email, password }`. Administrators (and customers who enabled it) have two-factor, so the
panel uses the **stepwise** flow:

1. `POST /api/auth/login` with `{ email, password, stepwise: true }` returns `{ requires2fa: true, methods: ["totp"] | ["totp","passkey"] | ["passkey"], challenge }`
   without creating a session.
2. Complete it with `POST /api/auth/challenge` `{ challenge, code }` (authenticator code or recovery code), or the passkey pair
   `POST /api/auth/passkey/options` `{ challenge }` then `POST /api/auth/passkey/verify` `{ challenge, response }`.
3. The response sets the `fledge_session` cookie.

The legacy inline form `{ email, password, totp }` still works for authenticator accounts. Accounts that only have a
passkey must use the stepwise flow.

Cookie-authenticated requests are checked against `WEB_ORIGIN`; WebSocket upgrades check the `Origin` header too. A
bearer token on a request always wins over a cookie, so a token can never inherit browser privileges.

Other routes: `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`,
`POST /api/auth/sessions/revoke-others`, passkey management under `/api/auth/passkeys`, `POST /api/auth/forgot`,
`POST /api/auth/token/accept` (invitation or reset link) and `POST /api/auth/recover` (recovery code).

First run: `POST /api/auth/bootstrap` with `{ email, password }` (12 or more characters) creates the first administrator
and succeeds only while none exists.

## API tokens (integrations)

Administrators create tokens under **Settings → API tokens** or `POST /api/tokens` `{ name, scopes, expiresAt? }`. The secret
is returned **once**. Send it as `Authorization: Bearer <token>`.

| Scope | Allows (exactly) |
| --- | --- |
| `read` | `GET` of `/api/auth/me`, `/api/customers`, `/api/customers/:id`, `/api/servers`, `/api/servers/:id`, `/api/jobs`, `/api/templates` |
| `provision` | `POST /api/customers`, `POST /api/servers` |
| `suspend` | `POST /api/servers/:id/actions` with `suspend` or `unsuspend` |

Everything else (nodes, files, backups, settings, deletion, token management, metrics) is **not** reachable with a token.
Tokens are subject to the administrator [IP allow-list](/panel/settings) and are revoked when the account's password is
reset. In the [endpoint reference](/api/reference/) an operation shows **Token scope** only when a token can reach it.

## Node credentials

Agents enrol once with a one-time token (`POST /api/agent/enroll`) and then send `Authorization: Bearer <credential>` and
`X-Node-ID: <uuid>`. See the [agent protocol](/api/agent-protocol).

## Brute-force protection

Sign-in, recovery, token acceptance and other sensitive routes share PostgreSQL-backed rate limits (so they hold across
replicas). Second-factor failures are additionally counted **per account**: ten failures within fifteen minutes lock the
second step for that account. See [Errors, paging, limits](/api/conventions).
