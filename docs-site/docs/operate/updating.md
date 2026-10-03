---
title: Updating and rollback
---

# Updating and rollback

Read the [release notes](/releases/) first. Database changes are additive and applied automatically, but they are
not reversed by a rollback, so keep an independent backup of PostgreSQL.

## From the panel

**Updates** (administrators) checks the latest GitHub release of the configured repository. **Update to vX.Y.Z.N** starts the update, which:

1. dumps PostgreSQL to `.backups/`,
2. keeps the database and S3 volumes and your `.env`,
3. rebuilds the `api`, `web` and `plugins` services,
4. checks the API and panel (the plugin host check only warns),
5. if the checks fail, restores the previous application revision where possible.

The updater runs as a private Compose service with access to the Docker socket and the project checkout. It is not
published to the host. Treat access to the Docker daemon as host-level access, and install Fledge only on hosts you
administer.

## From the command line

```sh
sh ./update.sh              # latest release
sh ./update.sh v0.6.2.1     # a specific release
sh ./update.sh --check      # verify prerequisites only
```

```powershell
.\update.ps1                # latest
.\update.ps1 -Version v0.6.2.1
.\update.ps1 -CheckOnly
```

The scripts require a clean Git checkout, Docker Compose 2.20 or newer and the same health checks as the panel
updater. They rebuild only the services the checked-out release defines, so rolling back to a release without the
plugin host never asks for it.

## Node agents

Agents update separately from **Nodes**; see [Agent updates](/agent/updates). Add-ons need agents on 0.6.1.1 or newer.

## After an update

- Check **Updates** and **Nodes** for a green state.
- Open **Plugins**: bundled plugins that gained permissions are switched off until you approve them.
- Read the "Upgrading" section of the release notes for new optional settings.

## Rolling back

If an update fails its health checks, the updater restores the previous revision itself. To roll back by hand:

```sh
git checkout --detach <previous-revision>
docker compose up -d --build
```

Restore the database from `.backups/` only if the new schema broke something: additive tables and columns are
ignored by older code, so a code-only rollback is usually enough.
