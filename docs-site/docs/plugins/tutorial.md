---
title: "Tutorial: your first catalog"
---

# Tutorial: your first catalog

We will build **Tiny Catalog**: a plugin that lists mods from a JSON file you host, so your Fabric servers get a
**Mods** tab with your own curated list. Everything on this page is real: the files below are
[`docs-site/examples/tiny-catalog`](https://github.com/kavaliersdelikt/fledge/tree/main/docs-site/examples/tiny-catalog), and
the documentation build runs them against the real plugin sandbox, so they cannot drift from the API.

## 1. The catalog file

Host a JSON file over HTTPS (any static host works). It lists mods and, for each, a version, what it supports and the one
file to install, including its **SHA-512** and size:

```json
{
  "items": [
    {
      "id": "hello-mod",
      "title": "Hello Mod",
      "summary": "Says hello.",
      "version": "1.2.0",
      "gameVersions": ["1.21.4"],
      "loaders": ["fabric"],
      "file": {
        "url": "https://downloads.example.org/hello-mod-1.2.0.jar",
        "sha512": "<128 hex characters>",
        "size": 12345
      }
    }
  ]
}
```

Compute the hash with `sha512sum hello-mod-1.2.0.jar`.

## 2. The manifest

<<< @/../examples/tiny-catalog/fledge-plugin.json{json}

- `permissions` declare everything the plugin may do. `network:downloads.example.org` allows HTTPS requests to that host
  **and** is the only place the panel lets a node download this plugin's files from. `servers:read` lets the panel pass the
  server's loaders and version to the catalog; `servers:files.write` lets the panel install files on a user's behalf.
- `catalogs` says this plugin serves mods (`kind: "mod"`), which is what Fabric, Quilt, Forge and NeoForge servers ask for.
- `settings` become a form in the install wizard; the value arrives as `host.settings.indexUrl`.

Full field list: [Manifest and permissions](/plugins/manifest).

## 3. The code

<<< @/../examples/tiny-catalog/index.js{js}

How it fits together:

- `globalThis.fledgePlugin` is the one thing a plugin exports; every method may be `async`.
- `host.fetch` is the only way out. It enforces your declared hosts, HTTPS and size limits; see the [host API](/plugins/host-api).
- `target` is the server: `{ kind, loaders, gameVersion, type }`. Return only what fits it.
- **`resolve` must return a SHA-512 and an exact size.** The panel refuses anything else, and the node verifies the hash
  before writing the file. See the [catalog contract](/plugins/catalog) for every method and the checks the panel applies.

## 4. Build the package

```sh
node plugins/tools/pack.mjs pack docs-site/examples/tiny-catalog --out dist
# dist/tiny-catalog-1.0.0.fledgeplugin
```

## 5. Install and try it

1. **Plugins → Settings → Allow community plugins** (your plugin is unsigned; see [signing](/plugins/packaging)).
2. **Plugins → Install from file**, choose the package, approve the permissions, set **Catalog file** to your URL and press
   **Test connection**, then turn it on.
3. Open a Fabric server: the **Mods** tab now offers **Tiny catalog** next to any other catalog plugin.

## 6. Where to go next

- Make search richer: pagination, categories, icons (icon hosts must be among your `network:` hosts).
- Report dependencies in `resolve`: `[{ projectId, type: 'required' }]` makes the panel install them too.
- Add `hooks` to react to events: [Hooks](/plugins/hooks).
- Sign and publish through a registry: [Packaging, signing, registry](/plugins/packaging).
- Test against the sandbox like the docs do: [Testing](/plugins/testing).
