# Plugin security model

This page is meant for administrators deciding what to install and for reviewers. It states what the
design protects against, and what it does not.

## Trust tiers

| Tier | Where it comes from | Installable when |
|---|---|---|
| **Bundled** | Ships in the panel image (`plugins/bundled`) | Always; you still approve its permissions |
| **Verified** | A registry entry whose Ed25519 signature matches a key under *Plugins → Settings → Trusted keys* | Always; you approve permissions |
| **Community** | An unsigned registry entry, or an uploaded `.fledgeplugin` | Only after you turn on *Allow community plugins* |

Community plugins are not reviewed by anyone. Treat installing one like installing any third-party
software: read what it asks for, and prefer plugins whose source you can read.

## What is enforced

1. **Isolation.** Plugin code runs in QuickJS compiled to WebAssembly: separate heap, no Node APIs, no file
   system, no sockets, no timers. Constructor-chain and global-lookup escapes find nothing (covered by
   `plugins/host/test`).
2. **A host with nothing to steal.** The `plugins` container has no database credentials, no Docker
   socket, no published port, a read-only root file system, all capabilities dropped, a PID and memory
   limit, and sits on a network shared only with the API. It never calls the panel.
3. **Network rules.** Plugin requests go through the host: HTTPS only, default port only, the host name must
   be one the administrator approved, DNS answers must be public addresses and the connection is pinned to
   the address that was checked (no DNS rebinding), redirects are re-checked, and size and time are
   bounded. Requests to `localhost`, private ranges, link-local addresses (cloud metadata) and IPv4-mapped
   IPv6 forms are refused.
4. **Consent.** Permissions are shown in plain language and must be approved at install; an update with
   additional permissions is refused until approved again. Bundled plugins that gain permissions in a
   panel update are switched off until approved.
5. **Distrust of results.** Everything a plugin returns is validated by the panel: file URLs must be
   HTTPS on approved hosts, file names are restricted and path-free, a SHA-512 is mandatory, sizes are
   bounded, text is truncated, images and links are limited to approved hosts and schemes. The node
   downloads the file itself, verifies the checksum, refuses private addresses and redirects to other
   hosts, and writes with the same path-safety code as uploads.
6. **Acting as the user.** Installs go through the same server access checks as the file manager: a user
   needs the `files` permission on that server. Plugins cannot touch servers the user cannot.
7. **Supply chain.** Registry downloads must match the SHA-256 in the index; signatures bind
   `id`, `version` and the exact bytes; a package whose manifest disagrees with its registry entry is
   refused. Plugin code is stored in the database and sent to the host by checksum, so the host cannot be
   made to run different code than was approved.
8. **Containment of failure.** Time, memory, request and size limits apply to every call; a plugin that
   times out, throws syntax errors or returns oversized data five times in a row is switched off and an
   administrator is notified.
9. **Auditing.** Install, update, enable, disable, settings changes, rollback, uninstall, automatic
   shut-off and every add-on install, update and removal are written to the audit log.

## What is not claimed

- WebAssembly isolation reduces risk; it is not a formal proof. A flaw in QuickJS or the WebAssembly
  runtime could in principle allow an escape. The container hardening above limits what an escape could
  reach, but that is defence in depth, not a guarantee.
- A malicious catalog can still **lie**: it can offer a harmful file with a matching checksum, or hide a
  better version. Checksums prove the file is the one the catalog named, not that it is safe. Only install
  add-ons from sources you trust. Fledge does not scan jars for malware.
- The `network:` hosts of a catalog plugin double as the places add-on files may be fetched from. Approve
  hosts you trust to serve files.
- Registry signatures only prove who signed. The panel ships with no built-in trusted key; add the keys you
  trust.
- Plugin hooks and catalog calls run with the API's own network position (through the plugin host). Do not
  put services on the `plugins_net` network.

## Hardening checklist for operators

- Keep *Allow community plugins* off unless you need it.
- Only add trusted keys for registries you use.
- Review the permissions dialog; a catalog should not need `storage` or `hooks`.
- Keep the plugin host on its own network (the default Compose file does).
- Watch **Plugins → Installed → Logs** and the audit log after installing something new.

## Reporting problems

See [SECURITY.md](../../SECURITY.md).
