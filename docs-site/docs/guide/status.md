---
title: Status and known gaps
---

# Status, verification and known gaps

Fledge is **beta**: suitable for evaluation and controlled testing, not for paying customers without the hardening and real-node tests below.

## What is tested

- **API integration suites** run a real API and plugin host against throw-away PostgreSQL databases and simulated nodes. They cover
  authentication and two-factor, request throttling, enrollment, placement, job leasing and fencing, permissions, live console routing,
  server operations, plugins and the add-on flow (against a mock shaped like Modrinth), templates, quotas, ports, cloning, schedules,
  crash policy, notifications, metrics, sessions, invitations, passkeys (with a software authenticator), the IP allow-list, audit export,
  OpenAPI and headers. See [Tests](/dev/tests).
- **Agent tests** (Go) cover SFTP, safe file operations, backup lifecycle, archive verification and restore, console framing, the console
  pipe stop logic, exit information and the add-on file jobs. An optional Docker test checks live stdin against a disposable container.
- **Script tests** run the installers and updaters against stubbed Docker and Git.
- **Real runs** have included a real Minecraft Java container on Docker Desktop with a WSL2 agent (console, file listing, resource samples, a
  S3-compatible backup and restore), real Fabric and Paper servers with mods and plugins installed from live Modrinth, a real Paper server
  stopped while it was still starting, kernel disk limits, uploads, agent self-update and failover across two agents with separate Docker
  daemons.

## Known gaps

Unresolved operational limits:

- Sustained multi-replica and load testing; a formal security review.
- Real AWS S3 retention, Valheim boot, failover across physical hosts and with a real game, SFTP with third-party clients on a dedicated node.
- Game-boot restore verification: scheduled verification checks an archive, it does not start the game.
- Hard quotas cover each server's data directory only, not the container's writable layer.
- Live migration without downtime; failover is backup-based.
- Native Windows services and containers; rootless agent operation.
- Passkeys with every browser and security key (verified with a software authenticator).
- Update rollback cannot reverse a database schema migration. Keep independent backups.
- Account recovery needs a saved recovery code; without one, an administrator with database access must intervene.
- The Docker socket remains root-equivalent for the agent and the updater.

Use dedicated Linux nodes, HTTPS, a restricted agent egress and firewall policy, off-host backups and tested restore procedures before
any production use. See the [Hardening checklist](/security/hardening).

## Backups are not game-aware

Snapshot backups are crash-consistent: the volume as if power were cut at that instant, with a world-save flush for Minecraft. Other games depend
on their own crash recovery. Without a volume, backups stop the game cleanly and depend on it honouring Docker's stop signal.

## Pterodactyl conversion

Conversion copies portable fields, the startup command and the stop command. Install scripts and Pterodactyl daemon images are not executed;
review imported templates. See [Templates](/panel/templates).

Each release's notes list what that release verified and what it did not.
