---
title: Limits
---

# Limits

## Per call

| Limit | Value |
| --- | --- |
| Run time | 25 seconds |
| Memory | 64 MB |
| Requests (`host.fetch`) | 40 |
| Response data | 24 MB total, 8 MB per response |
| Result size | 2 MB |
| Storage | 256 KB per plugin (`storage` permission) |
| Log lines | 100 per call (the panel keeps the last 500) |
| Redirects | 3, each re-checked |
| Hooks | 8 seconds, best effort |

## Package and manifest

Package up to 2 MB; `index.js` up to 1 MB; icon up to 100 KB; at most 20 permissions, 30 settings fields and 4 catalogs;
`description` up to 400 characters.

## Network rules

HTTPS only, default port only, the host must be declared in a `network:` permission, DNS answers must be public addresses and
the connection is pinned to the checked address, redirects are re-checked, requests to `localhost`, private ranges,
link-local (cloud metadata) and IPv4-mapped IPv6 forms are refused, and credentials in URLs are rejected. Only `GET`, `HEAD`
and `POST` are available. Wildcards such as `*.github.io` that cover shared hosting platforms cannot be granted.

## Error codes

A failed call surfaces one of these codes (visible in the plugin's Logs):

| Code | Meaning | Counts towards auto-disable |
| --- | --- | --- |
| `timeout` | The plugin's own code ran past the limit | yes |
| `upstream-timeout` | The deadline passed while a request to the catalog was still pending | no |
| `script-error` | Syntax error or an exception while loading | yes |
| `too-large` | Result over 2 MB | yes |
| `host-error`, `bad-method` | Internal or missing method | yes |
| `plugin-error` | An error the plugin threw while running | no (shown to the administrator) |
| `host-denied`, `rate-limit`, `limit`, `network` | Errors a failed `host.fetch` rejects with (`e.code`) | no |

A plugin is switched off after **five consecutive** counted failures.

## Single-process note

The plugin host runs plugin calls in one process, so a slow catalog can delay other plugin calls. Keep calls short.
