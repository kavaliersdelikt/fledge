---
title: Manifest and permissions
---

# Manifest and permissions

Every plugin package contains `fledge-plugin.json`. API version 1.

## Fields

| Field | Required | Notes |
|---|---|---|
| `id` | yes | 2–49 characters: lowercase letters, digits, hyphens |
| `name`, `description`, `author`, `license` | yes | Plain text. `description` up to 400 characters |
| `version` | yes | `1.2.3` or `1.2.3.4`, optional `-suffix` |
| `apiVersion` | yes | `1` |
| `homepage` | no | `https://` URL |
| `minPanelVersion`, `minAgentVersion` | no | The panel refuses to install on older versions |
| `permissions` | no | See below. At most 20 |
| `settings` | no | List of fields, see below. At most 30 |
| `catalogs` | no | `{ id, label, kind, description? }`, at most 4. `kind` is `mod` or `plugin` for the Minecraft templates, or any word your own templates use |
| `hooks` | no | Events the plugin wants to be told about. Needs the `hooks` permission |
| `payments` | no | Makes the plugin a payment provider: `{ id, label, intervals, currencies, features }`. Needs the `payments` permission. See [the payments contract](/plugins/payments) |

## Permissions

| Permission | Meaning |
|---|---|
| `network:<host>` | May make HTTPS requests to that host (`api.example.com`) or a wildcard (`*.example.com`). IP addresses, `localhost`, `*.local`, `*.internal` and bare TLD wildcards are rejected. The same hosts are the **only** hosts the panel lets a node download add-on files from for this plugin. |
| `servers:read` | Receives the target server's game type, loaders and Minecraft version when the catalog is used. Required for catalogs. |
| `servers:files.write` | The panel may install files into servers on the plugin's behalf (only after a user confirms an install). |
| `storage` | A small private key-value store (256 KB). |
| `hooks` | May be notified about server and add-on events. |
| `payments` | Takes payments and manages subscriptions through one provider. It sees order details and customers' email addresses and holds your API keys. Only for payment plugins |

Administrators see these in plain language and must approve them. An update that asks for more
permissions needs approval again.

## Settings fields

```json
{ "key": "releaseChannel", "label": "Release channel", "type": "select",
  "default": "release", "options": [{ "value": "release", "label": "Stable" }],
  "help": "…", "required": false }
```

Types: `string` (`pattern`, `placeholder`), `number` (`min`, `max`), `boolean`, `select`, `secret`
(encrypted at rest, never shown again; `null`/missing keeps the stored value). Values reach the plugin as
`host.settings`.
