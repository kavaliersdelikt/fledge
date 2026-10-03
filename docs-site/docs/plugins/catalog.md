---
title: Catalog contract
---

# Catalog contract



A single script sets `globalThis.fledgePlugin` to an object. All methods may be `async` and must return
JSON-serialisable values (up to 2 MB). Errors you throw are shown to the administrator (keep the message
human).

`target` (second argument of every catalog method) describes the server:

```json
{ "kind": "mod", "loaders": ["fabric"], "gameVersion": "1.21.11", "type": "FABRIC" }
```

`gameVersion` is `null` when the server uses `LATEST` or has no concrete version.

## Catalog methods

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
