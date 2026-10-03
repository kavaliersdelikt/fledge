---
title: The bundled plugins
---

# The bundled plugins

Three plugins ship inside the panel image (`plugins/bundled`) and are never downloaded. The two Modrinth browsers share about 200 lines of
code (`_shared/modrinth.js`) and differ in a seven-line entry file, which makes them good examples. The third, **Stripe Payments**, is the
first [payment provider](/plugins/payments); it has [its own page](/plugins/stripe).

| | **Modrinth Mod Browser** (`modrinth-mods`) | **Modrinth Plugin Browser** (`modrinth-plugins`) |
| --- | --- | --- |
| Serves | `kind: mod` catalogs: Fabric, Quilt, Forge, NeoForge servers | `kind: plugin` catalogs: Paper, Purpur, Folia, Spigot servers |
| Permissions | `network:api.modrinth.com`, `network:cdn.modrinth.com`, `servers:read`, `servers:files.write` | the same |
| Shows | mods that support the **server** side | plugins |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Release channel | Stable releases only | Which builds are installed by default and offered as updates: stable, releases and betas, or everything |
| Show client-only mods | off | Client-only mods do nothing on a server (mod browser) |
| Results per page | 24 | 5 to 50 |
| Contact for Modrinth | empty | Added to the User-Agent so Modrinth can reach you; never shown to players |

## What they do

- **Search** Modrinth, sorted by relevance, downloads, follows, newest or recently updated, filtered by category and by the
  server's loader and Minecraft version.
- **Project pages** with description (rendered as safe Markdown), gallery, links and versions.
- **Resolve** a version into one file with its SHA-512, plus required, optional and incompatible dependencies.
- **Updates**: given the installed versions (and hashes), report newer compatible ones.
- A **health check** (`Test connection`) that queries a harmless Modrinth endpoint.

All network access goes through the plugin host to the two Modrinth hosts. File downloads are done by the **node** from
`cdn.modrinth.com`, and verified against the SHA-512 Modrinth publishes.

## Source

- [`plugins/bundled/modrinth-mods`](https://github.com/kavaliersdelikt/fledge/tree/main/plugins/bundled/modrinth-mods)
- [`plugins/bundled/modrinth-plugins`](https://github.com/kavaliersdelikt/fledge/tree/main/plugins/bundled/modrinth-plugins)
- [`plugins/bundled/_shared/modrinth.js`](https://github.com/kavaliersdelikt/fledge/blob/main/plugins/bundled/_shared/modrinth.js)

Copy them as a starting point for catalogs of other sources: see the [tutorial](/plugins/tutorial).
