# Writing Fledge plugins

A Fledge plugin is a small, sandboxed JavaScript program that extends the panel. The panel renders
the interface; the plugin supplies data. In 0.6 the extension point is the **catalog**: a plugin that
can search a source of mods, plugins or other add-ons and say which files make up a version. The
panel adds the browser, the dependency review, the safe download to the node, updates and removal.

The two bundled plugins, **Modrinth Mod Browser** and **Modrinth Plugin Browser**, are good examples:
see [`plugins/bundled`](../../plugins/bundled) (about 200 lines of shared code plus a 7-line entry
file each).

- [Reference: manifest, catalog contract and host API](reference.md)
- [Security model and trust tiers](security.md)

## How a plugin runs

```
 Browser ── Fledge panel (API) ── plugin host ── your plugin (WebAssembly sandbox)
                  │                    │
           checks every answer     only talks to the hosts you declared
```

- Your code runs in **QuickJS compiled to WebAssembly** inside the `plugins` container. It has its own
  heap and **no** Node APIs, file system, timers or sockets. The only door out is the `host` object.
- The plugin host has no database credentials, no Docker socket and no published port. Only the API can
  call it.
- Every call has a time limit (25 s), a memory limit (64 MB), a limit on requests (40) and on response
  size. A plugin that keeps crashing is switched off automatically.
- Whatever your plugin returns is **validated by the panel** before anything happens: file names,
  checksums, download hosts and sizes are checked again, and the node verifies the checksum itself.

## Package layout

A package is a zip file named `<id>-<version>.fledgeplugin`:

```
fledge-plugin.json    manifest (required)
index.js              your code, one script (required, up to 1 MB)
icon.svg | icon.png   shown in the store (optional, up to 100 KB)
README.md             shown in the plugin's About tab (optional)
CHANGELOG.md          optional
```

## A first plugin

`fledge-plugin.json`

```json
{
  "id": "hello-catalog",
  "name": "Hello Catalog",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "A catalog with one hard-coded mod.",
  "author": "You",
  "license": "MIT",
  "permissions": ["network:cdn.example.org", "servers:read", "servers:files.write"],
  "catalogs": [{ "id": "hello", "label": "Hello", "kind": "mod" }]
}
```

`index.js`

```js
globalThis.fledgePlugin = {
  async search(params, target) {
    return { total: 1, offset: 0, limit: 24, items: [{ id: 'hello', title: 'Hello Mod', summary: 'Says hello.', downloads: 1, follows: 0, categories: [] }] };
  },
  async resolve(args, target) {
    return {
      project: { id: 'hello', title: 'Hello Mod' },
      version: { id: 'v1', label: '1.0.0', channel: 'release' },
      files: [{ url: 'https://cdn.example.org/hello-1.0.0.jar', filename: 'hello-1.0.0.jar', sha512: '<128 hex characters>', size: 12345 }],
      dependencies: []
    };
  }
};
```

Build, sign and test it:

```sh
node plugins/tools/pack.mjs pack ./hello-catalog --out dist
```

Install the file under **Plugins → Install from file** (turn on *Allow community plugins* in
**Plugins → Settings** first). The wizard shows the permissions you declared; approve, configure, turn on.
Open a Minecraft server that matches `kind: "mod"` (Fabric, Quilt, Forge or NeoForge) and the
**Mods** tab lists your catalog.

## Publishing

- **Community**: share the `.fledgeplugin` file. Administrators must allow community plugins and approve
  its permissions.
- **Registry**: the panel reads a signed JSON index (default
  [`plugins/registry/index.json`](../../plugins/registry/index.json) in the Fledge repository). Build
  packages with `pack.mjs pack`, then `pack.mjs index <dist> --base-url https://… --sign key.pem`. A
  plugin whose signature verifies against a key in **Plugins → Settings → Trusted keys** is shown as
  *Verified*; everything else is *Community*.
- **Bundled**: plugins in `plugins/bundled` ship inside the panel image and are never downloaded.

Signing keys: `node plugins/tools/pack.mjs keygen ./keys` creates an Ed25519 key. Keep the private key
safe and offline; publish the public key.

## Testing

- `host-sandbox` tests (`plugins/host/test`) show how to drive a plugin in the sandbox with a mock server.
- `api/test/modrinth-mock.mjs` is a fake Modrinth API that the Modrinth plugins run against in
  `api/test/plugins-smoke.mjs`; copy the idea for your own source.
- `npm run test:plugins` in `api/` runs the end-to-end plugin tests (needs PostgreSQL, see the main README).
