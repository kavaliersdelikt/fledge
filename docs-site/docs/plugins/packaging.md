---
title: Packaging, signing, registry
---

# Packaging, signing, registry

Everything is done with `plugins/tools/pack.mjs` (needs `npm ci` in `plugins/tools` once).

```text
node pack.mjs keygen <outdir>                           new Ed25519 signing key (PEM) + public key
node pack.mjs pack <plugin-dir> [--out dist] [--sign key.pem]
node pack.mjs index <dist-dir> --base-url <url> [--sign key.pem] [--out index.json]
node pack.mjs verify <file.fledgeplugin> --key <base64-spki> --signature <base64>
```

## Package

`pack` reads `fledge-plugin.json` and `index.js` (or `plugin.js`, optionally with an `include` list of shared files that are
concatenated in front, like the bundled plugins do), plus an optional `icon.svg`/`icon.png`, `README.md` and `CHANGELOG.md`.
It validates the id (2-49 lowercase letters, digits or hyphens) and version (`1.2.3` or `1.2.3.4`) and writes
`<id>-<version>.fledgeplugin`, a zip.

## Signing

```sh
node plugins/tools/pack.mjs keygen ./keys           # keep the private key offline
node plugins/tools/pack.mjs pack ./my-plugin --out dist --sign ./keys/fledge-plugin-signing.key.pem
```

A signature covers the message `fledge-plugin:v1:<id>:<version>:<sha256-of-package>`, so it binds the plugin's identity, version
and exact bytes. `keygen` refuses to overwrite an existing key.

## Publishing

| Way | How |
| --- | --- |
| **Share the file** | Administrators install it as a *Community* plugin after turning on *Allow community plugins* and approving permissions |
| **Registry** | Host the packages and a signed index; administrators add your public key under **Plugins → Settings → Trusted keys** and the registry URL. Plugins whose signature verifies against a trusted key show as *Verified* |
| **Bundled** | Plugins in `plugins/bundled` ship inside the panel image and are never downloaded (contributions to Fledge itself) |

Build the index from a folder of packages:

```sh
node plugins/tools/pack.mjs index dist --base-url https://plugins.example.org/ --sign ./keys/fledge-plugin-signing.key.pem --out index.json
```

`--base-url` must be `https`. The index lists each package with its SHA-256, download URL and signature. The panel checks
that a package's manifest agrees with its registry entry, that the download matches the SHA-256, and that the signature
verifies against a trusted key.

The default registry is `plugins/registry/index.json` in the Fledge repository (currently empty). Set the registry URL under
**Plugins → Settings** (or the `PLUGIN_REGISTRY_URL` seed in `.env`).

## Versioning

- Bump `version` for every release; the panel refuses to "update" to an older version (use rollback instead).
- Set `minPanelVersion` / `minAgentVersion` if you depend on newer features; the panel refuses to install on older ones.
- Adding permissions needs the administrator's approval again on update.

## Release signing of Fledge itself

Fledge's own releases publish the bundled plugin packages, checksums, SBOMs and (when configured) signatures. See
[Verifying releases](/security/supply-chain).
