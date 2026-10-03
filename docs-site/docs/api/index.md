---
title: API overview
---

# API overview

Fledge's HTTP API is what the panel itself uses. Every route is under `/api`. A machine-readable
**OpenAPI 3.1** description is generated from the running API:

- in the panel: **API** (administrators), with curl examples,
- over HTTP: `GET /api/openapi.json` (administrator),
- in these docs: the [endpoint reference](/api/reference/), generated from the same description.

Routes are collected as they are registered, so no route can be missing from the description; summaries and request
fields exist for the endpoints people integrate with, and the rest are listed as *Undocumented*.

## Quick example

```sh
# 1. Create an API token in the panel (Settings → API tokens) with the scopes you need
TOKEN=<the token shown once at creation>

# 2. List servers
curl -s -H "Authorization: Bearer $TOKEN" https://panel.example.com/api/servers

# 3. Provision a server (needs the "provision" scope)
curl -s -X POST https://panel.example.com/api/servers \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Survival","ownerId":"<customer-uuid>","templateId":"minecraft-paper"}'

# 4. Suspend it (needs "suspend")
curl -s -X POST https://panel.example.com/api/servers/<id>/actions \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"action":"suspend"}'
```

## Three kinds of caller

| Caller | Authenticates with | Reaches |
| --- | --- | --- |
| **Browser / panel** | Session cookie `fledge_session` (`HttpOnly`, `SameSite=Strict`) | Everything the signed-in user may do |
| **Integration** | `Authorization: Bearer <token>` | A small allow-list with scopes `read`, `provision`, `suspend` |
| **Node agent** | `Authorization: Bearer <credential>` plus `X-Node-ID` | The [agent protocol](/api/agent-protocol) |

Read [Authentication](/api/authentication) for details, [Errors, paging, limits](/api/conventions) for conventions and the
other pages in this section for the live console WebSocket, webhook payloads and the node protocol.

## Versioning

The API is versioned with the panel (shown in the OpenAPI `info.version`). Within the 0.6 series, changes are additive;
check the [release notes](/releases/) before upgrading integrations.
