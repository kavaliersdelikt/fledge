---
title: Configuration
---

# Configuration

Fledge keeps most settings in the panel (**Settings**), stored in the database with secrets encrypted. `.env` holds
only what must exist before the panel can start, plus optional seeds.

| Where | What |
| --- | --- |
| `.env` (required) | `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `WEB_ORIGIN` |
| `.env` (deployment) | `NEXT_PUBLIC_API_URL`, `API_BIND`, `WEB_BIND`, `TRUST_PROXY`, `APP_VERSION`, `GITHUB_REPOSITORY` |
| `.env` (seeds) | `S3_*`, `ALLOWED_IMAGE_PREFIXES`, `SMTP_*`, `PLUGIN_REGISTRY_URL`, `WEBAUTHN_*`. They only fill the matching panel form until it is saved once; after that the database wins |
| Panel | Object storage, SFTP, allowed images, update sources, failover, email, plugin registry and trusted keys, admin network allow-list, audit retention |

The complete, generated list of variables (including those used only by the API process) is in
[Environment variables](/reference/environment).

## Important variables

### `WEB_ORIGIN`

The exact origin the browser uses to open the panel, for example `https://panel.example.com`. The API uses it for
CORS and for the `Origin` check on cookie-authenticated requests, and passkeys are bound to its host. A mismatch
shows up as sign-in failing or "could not reach the API".

### `NEXT_PUBLIC_API_URL`

The browser-reachable address of the API. Empty means "the panel's host on port 4000", which suits local use. Behind
a [reverse proxy](/operate/reverse-proxy) that serves panel and API on one origin, set it to that origin. It is
compiled into the panel image, so changing it needs `docker compose up --build -d`.

### `TRUST_PROXY`

Set it when the API sits behind a reverse proxy, so rate limits and the administrator allow-list see real client
addresses. Use the number of proxy hops (`1` for a single proxy), or a comma-separated list of proxy addresses or
ranges. `true` trusts every hop and is only safe when the API cannot be reached except through the proxy. Leave it
unset when the API is exposed directly.

### `ADMIN_IP_ALLOW_DISABLE`

Break-glass switch: set `true` to ignore the administrator network allow-list if you locked yourself out, then
restart the API and fix the list under **Settings → Security**.

## Settings in the panel

See [Settings](/panel/settings) for the full tour.

## Where data lives

| Data | Location |
| --- | --- |
| Accounts, servers, jobs, audit, plugin state | PostgreSQL volume `postgres_data` |
| Game data | On each node, in the agent's data directory (by default as per-server loop-mounted ext4 images) |
| Backups | Your S3-compatible bucket |
| Panel database dumps from updates | `.backups/` in the checkout |
| File transfer spool (when no object storage) | Volume `transfer_spool` |
