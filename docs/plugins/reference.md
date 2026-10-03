# Plugin reference (API version 1)

## Manifest (`fledge-plugin.json`)

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

### Permissions

| Permission | Meaning |
|---|---|
| `network:<host>` | May make HTTPS requests to that host (`api.example.com`) or a wildcard (`*.example.com`). IP addresses, `localhost`, `*.local`, `*.internal` and bare TLD wildcards are rejected. The same hosts are the **only** hosts the panel lets a node download add-on files from for this plugin. |
| `servers:read` | Receives the target server's game type, loaders and Minecraft version when the catalog is used. Required for catalogs. |
| `servers:files.write` | The panel may install files into servers on the plugin's behalf (only after a user confirms an install). |
| `storage` | A small private key-value store (256 KB). |
| `hooks` | May be notified about server and add-on events. |

Administrators see these in plain language and must approve them. An update that asks for more
permissions needs approval again.

### Settings fields

```json
{ "key": "releaseChannel", "label": "Release channel", "type": "select",
  "default": "release", "options": [{ "value": "release", "label": "Stable" }],
  "help": "…", "required": false }
```

Types: `string` (`pattern`, `placeholder`), `number` (`min`, `max`), `boolean`, `select`, `secret`
(encrypted at rest, never shown again; `null`/missing keeps the stored value). Values reach the plugin as
`host.settings`.

## What a plugin exports

A single script sets `globalThis.fledgePlugin` to an object. All methods may be `async` and must return
JSON-serialisable values (up to 2 MB). Errors you throw are shown to the administrator (keep the message
human).

`target` (second argument of every catalog method) describes the server:

```json
{ "kind": "mod", "loaders": ["fabric"], "gameVersion": "1.21.11", "type": "FABRIC" }
```

`gameVersion` is `null` when the server uses `LATEST` or has no concrete version.

### Catalog methods

| Method | Called with | Returns |
|---|---|---|
| `healthCheck()` | – | `{ ok, message }` – the **Test connection** button |
| `search(params, target)` | `{ query, offset, limit, sort, categories[], showClientOnly? }` | `{ total, offset, limit, items:[{ id, slug, title, summary, iconUrl, author, downloads, follows, categories[], clientSide, serverSide, updatedAt, url }] }` |
| `categories(target)` | – | `[{ id, label }]` |
| `project(id, target)` | project id | `{ id, slug, title, summary, description (markdown), iconUrl, categories, license, clientSide, serverSide, downloads, follows, updatedAt, publishedAt, gallery:[{url,title}], links:{page,source,issues,wiki,discord} }` |
| `versions(id, target)` | project id | `[{ id, label, name, channel (release/beta/alpha), publishedAt, gameVersions[], loaders[], downloads, changelog, files:[{filename,size,primary}] }]`, already filtered for `target` |
| `resolve({ projectId?, versionId? }, target)` | – | `{ project:{id,title,slug,iconUrl}, version:{id,label,channel,publishedAt}, files:[{ url, filename, sha512, size }], dependencies:[{ projectId, versionId, type }] }`. Without `versionId`, pick the newest version that is compatible with `target`. The first file is installed. |
| `updates({ items:[{ projectId, versionId, sha512 }] }, target)` | installed add-ons | `[{ projectId, currentVersionId, latest:{ …same shape as a `versions` entry… } }]` for those that have a newer compatible version |

`dependencies[].type` is `required`, `optional`, `incompatible` or `embedded`. The panel resolves
required dependencies recursively (depth 3, at most 15 files), offers optional ones and refuses to install
something that is incompatible with an installed add-on.

**What the panel checks in every `resolve` answer** (you cannot loosen these):
the file URL must be `https` on a host from your `network:` permissions; the file name must match
`[A-Za-z0-9._+()[\] -]{1,128}.jar`; a 128-character `sha512` is required; the size must be between 1 byte
and 256 MB. Search results are clamped and stripped too (icon URLs must be on your hosts, links must be
`https`, text is truncated).

### Hooks

```js
globalThis.fledgePlugin = { hooks: { 'server.created'(event) { host.log('info', 'new server ' + event.serverId); } } };
```

Events: `server.created`, `server.deleted`, `server.updated`, `addon.installed`, `addon.removed`.
Hooks run best-effort with an 8 s limit; their result is ignored.

## The `host` object

Available as a global inside the sandbox.

| | |
|---|---|
| `host.settings` | Your settings (secrets included, decrypted only for you) |
| `host.context` | `{ pluginId, version, panelVersion }` |
| `await host.fetch(url, { method, headers, body })` | `GET`, `HEAD` or `POST`. Returns `{ status, ok, headers, text(), json() }`. HTTPS only, default port, host must be declared, no private addresses, up to 3 redirects (each re-checked), 8 MB per response, 24 MB and 40 requests per call. Rejects with an `Error` (`e.code`: `host-denied`, `rate-limit`, `timeout`, …) |
| `host.storage.get(key)` / `.set(key, value)` / `.delete(key)` | Needs the `storage` permission. Synchronous; changes are saved when the call returns |
| `host.log(level, …)` / `console.log(…)` | Appears in the plugin's **Logs** tab (last 500 lines) |

There is no `setTimeout`, no `fetch`, no `require`/`import`, no `process`, no `Buffer`. `JSON`,
`Promise`, `async/await`, `encodeURIComponent` and the rest of the ECMAScript 2023 standard library work.

## Limits at a glance

25 s per call · 64 MB memory · 40 requests and 24 MB of responses per call · 2 MB result · 256 KB storage ·
100 log lines per call · package up to 2 MB · `index.js` up to 1 MB.
