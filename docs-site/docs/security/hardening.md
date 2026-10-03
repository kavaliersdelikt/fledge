---
title: Hardening checklist
---

# Hardening checklist

## Panel

- [ ] Serve the panel over **HTTPS** behind a [reverse proxy](/operate/reverse-proxy); set `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`
      and `TRUST_PROXY` correctly.
- [ ] Keep `API_BIND` and `WEB_BIND` on `127.0.0.1` (or a private interface behind a firewall).
- [ ] Keep `.env` private (mode `600`) and back up `ENCRYPTION_KEY` separately.
- [ ] Create the first administrator immediately after install; do not expose a fresh install.
- [ ] Store **recovery codes** offline; add a second authenticator or a **passkey**.
- [ ] Set the **administrator IP allow-list** if your admins have stable addresses; test that it shows your real address first.
- [ ] Configure **email** so password resets do not need an administrator.
- [ ] Protect the Docker socket: the updater service has it. Do not publish the updater and do not run other untrusted containers
      on the panel host.
- [ ] Keep Docker, the OS and Fledge updated; read release notes.

## Accounts

- [ ] Give customers the least permission they need; use collaborators with specific permissions instead of sharing accounts.
- [ ] Use **quotas** for customers.
- [ ] Use API tokens with the narrowest scope and an expiry; revoke unused ones.
- [ ] Review the **audit log** regularly; set retention to match your needs.

## Nodes

- [ ] Dedicated Linux hosts for production, not WSL2.
- [ ] HTTPS from nodes to the panel (never `ALLOW_INSECURE_HTTP`).
- [ ] Restrict egress and ingress with a firewall: only the published game ports (and SFTP, if on) inbound.
- [ ] Keep the **allowed images** list tight.
- [ ] Turn on **disk limit enforcement** (*Require*) so a game cannot fill the host.
- [ ] Rotate the enrollment credential if a node host may be compromised (new token, re-enrol).

## Backups

- [ ] Object storage with TLS, a bucket that only Fledge can write to, and versioning/retention on the bucket side as well.
- [ ] Test a restore periodically; turn on scheduled verification.
- [ ] Back up the panel database and `.env` (see [Backups](/operate/backups#backing-up-the-panel-itself)).

## Plugins

- [ ] Leave *Allow community plugins* off unless needed.
- [ ] Only trust signing keys you verified; remove old ones.
- [ ] Read the permissions dialog; a catalog should not need `storage` or `hooks`.
- [ ] Watch plugin Logs and the audit log after installing something new.
- [ ] Keep the plugin host on its own network (the default Compose file does).
