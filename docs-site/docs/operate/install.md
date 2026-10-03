---
title: Install
---

# Install the panel

## Requirements

- Docker Engine with **Docker Compose 2.20 or newer**.
- About 4 GB of RAM for the panel, database and a small workload.
- For game nodes: Linux, systemd, Docker Engine and a reachable (preferably HTTPS) panel URL. See [Connect a node](/agent/connect).
- Optional: an S3-compatible service for [backups](/operate/backups), reachable from the API **and** every node.

The panel stack runs on Linux, macOS and Windows (Docker Desktop, Linux containers with the WSL 2 engine). Game
nodes must be Linux.

## One command

::: code-group

```sh [Linux / macOS]
git clone --depth 1 --branch main https://github.com/kavaliersdelikt/fledge.git fledge && cd fledge && sh ./install.sh
```

```powershell [Windows PowerShell]
git clone --depth 1 --branch main https://github.com/kavaliersdelikt/fledge.git fledge; if ($LASTEXITCODE -ne 0) { throw 'Download failed.' }; Set-Location fledge; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1; if ($LASTEXITCODE -ne 0) { throw 'Install failed.' }
```

:::

The installer:

1. Checks Docker, the Compose version and the repository files.
2. Creates `.env` if it does not exist, with a random `POSTGRES_PASSWORD` and `ENCRYPTION_KEY`, in a file readable
   only by you. An existing `.env` is never overwritten.
3. Runs `docker compose up --build -d`.
4. Waits for the API and panel health checks. The plugin host is checked too; a problem there is only a warning,
   because the panel works without plugins.

| Option | Shell | PowerShell | Effect |
| --- | --- | --- | --- |
| Check only | `--check` | `-CheckOnly` | Verify prerequisites and files without changing anything |
| Don't wait | `--no-wait` | `-NoWait` | Start Compose without waiting for health checks |

## Manual install

```sh
git clone https://github.com/kavaliersdelikt/fledge.git
cd fledge
cp .env.example .env
```

Edit `.env`: set a long URL-safe `POSTGRES_PASSWORD` and a permanent 64-character hex `ENCRYPTION_KEY`
(`openssl rand -hex 32`), then:

```sh
docker compose up --build -d
docker compose ps
curl http://localhost:4000/api/health
```

::: warning Keep the encryption key
`ENCRYPTION_KEY` encrypts two-factor secrets, stored S3 credentials, SMTP passwords and plugin secrets. Replacing
it makes them unreadable. Back it up with your `.env`.
:::

## What gets started

| Service | Image / build | Published port | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | none | Volume `postgres_data` |
| `api` | `api/Dockerfile` | `127.0.0.1:4000` | Applies `db/schema.sql` at startup |
| `web` | `web/Dockerfile` | `127.0.0.1:3000` | The panel |
| `plugins` | `plugins/host/Dockerfile` | none | Read-only root, no capabilities, own network shared with the API only |
| `updater` | `api/Dockerfile` | none | Performs in-panel updates; has the Docker socket |
| `s3` | SeaweedFS | `127.0.0.1:9000` | Opt-in: `docker compose --profile bundled-s3 up -d` |

Ports bind to loopback by default. `API_BIND` and `WEB_BIND` in `.env` change that; for anything reachable from a
network, put a [reverse proxy with TLS](/operate/reverse-proxy) in front.

## First sign-in

Open the panel, create the administrator and enrol an authenticator. The first administrator can only be created
while none exists; do not expose a fresh install to the internet before you have done this.

## Uninstall

```sh
docker compose down        # keeps the database and S3 volumes
docker compose down -v     # also deletes the database and local S3 data
```
