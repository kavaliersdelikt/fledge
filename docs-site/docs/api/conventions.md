---
title: Errors, paging, limits
---

# Errors, paging, limits

## Format

JSON in, JSON out, `camelCase` for panel payloads (some job, schedule and audit rows keep SQL-style fields where the
endpoint reference shows them). Dates are UTC ISO strings. IDs are UUIDs.

## Errors

Errors are `{ "error": "<code>", "message": "<human text>" }` with one of these statuses:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Invalid input; the message says what |
| 401 | | Authentication required or invalid |
| 403 | `forbidden` | Not allowed (role, permission, token scope, IP allow-list, suspended) |
| 404 | | Not found, or you may not know it exists |
| 409 | `conflict` | State conflict (quota exceeded, already running, lease lost) |
| 413 | | Body or upload too large |
| 429 | | Rate limited |
| 502 | | An upstream (plugin, catalog) failed |
| 503 | | A feature is not set up (object storage, plugin host, email) |
| 504 | | Timed out waiting for a node |

Some errors carry extra `details` (for example `permissions_changed` on a plugin update lists the new permissions).

## Paging

List endpoints for customers, servers, jobs and activity accept `limit` (1 to 100, default 50) and `offset`. They return
arrays.

## Rate limits

Authentication and other sensitive writes are throttled with fixed windows stored in PostgreSQL, shared by every API
replica. Exceeding them returns `429`. Behind a reverse proxy set `TRUST_PROXY`, otherwise all callers share the proxy's
address (see [Reverse proxy](/operate/reverse-proxy)).

## Request size

JSON bodies are limited to 12 MB; file transfers to 1 GiB; the file editor to 1 MiB.

## CORS and headers

Only `WEB_ORIGIN` is allowed, with credentials. `Content-Disposition` is exposed for downloads. The API sends defensive
headers (`X-Content-Type-Options`, frame protection) and the panel sends a Content-Security-Policy.

## Idempotency and jobs

Mutating server operations queue a **job** and return `{ jobId, state }`. Poll `GET /api/jobs?serverId=` or watch the
[WebSocket](/api/websocket). Jobs are durable and leased to the node; a repeated request creates a repeated job, so check
the state before retrying.
