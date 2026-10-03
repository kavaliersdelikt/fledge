<div align="center">

<img src="docs/assets/fledge-symbol.png" width="76" alt="Fledge feather mark" />

# Fledge

**A clear home for the game servers you run.**

Manage customers, servers, templates, and Linux Docker nodes from one self-hosted panel.

<p>
  <a href="https://github.com/kavaliersdelikt/fledge/releases"><img src="https://img.shields.io/github/v/release/kavaliersdelikt/fledge?include_prereleases&amp;style=flat-square&amp;label=release&amp;color=8B5CF6" alt="Latest GitHub release" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-64748B?style=flat-square" alt="License: AGPL-3.0-only" /></a>
  <a href="https://github.com/kavaliersdelikt/fledge/stargazers"><img src="https://img.shields.io/github/stars/kavaliersdelikt/fledge?style=flat-square&amp;logo=github&amp;label=stars&amp;color=F59E0B" alt="GitHub stars" /></a>
  <a href="https://github.com/kavaliersdelikt/fledge/issues"><img src="https://img.shields.io/github/issues/kavaliersdelikt/fledge?style=flat-square&amp;label=issues&amp;color=38BDF8" alt="Open GitHub issues" /></a>
  <a href="#known-limits"><img src="https://img.shields.io/badge/status-evaluation-F59E0B?style=flat-square" alt="Project status: evaluation" /></a>
</p>

[Overview](#what-is-fledge) · [Plugins](#plugins-and-add-ons) · [Connect a node](#connect-a-node) · [Automation](#automation-and-notifications) · [Backups](#backups-and-recovery) · [Community](#community) · [Known limits](#known-limits)

<img src="docs/assets/banner2.png" width="100%" alt="Fledge — one panel, many worlds" />

<p>
  <a href="https://discord.gg/gu49ZF6tQh"><img src="https://img.shields.io/badge/Join_the_Discord-5865F2?style=for-the-badge&amp;logo=discord&amp;logoColor=white" alt="Join the Fledge Discord" /></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Quick_start-0F766E?style=for-the-badge&amp;logo=docker&amp;logoColor=white" alt="Quick start with Docker" /></a>
  <a href="#documentation"><img src="https://img.shields.io/badge/Read_the_docs-334155?style=for-the-badge" alt="Read the documentation" /></a>
  <a href="https://github.com/kavaliersdelikt/fledge/releases"><img src="https://img.shields.io/badge/Releases-334155?style=for-the-badge&amp;logo=github&amp;logoColor=white" alt="Browse releases and release notes" /></a>
</p>

**Building your own game server setup? Come build it with us.**<br />
Ask setup questions, share your servers, and help shape what Fledge becomes.


</div>

> **Version v0.6.x (Roost)** Fledge is an actively developed project. It is suitable for local evaluation and controlled testing; it has not completed a production security review.
>
> **License:** GNU Affero General Public License v3.0 only (AGPL-3.0-only). See [LICENSE.md](LICENSE.md). Modified versions offered as a network service must provide their corresponding source under the license terms.

## What is Fledge?

Fledge is a self-hosted control panel for operating game servers across multiple Linux Docker hosts. The web panel and API manage users, templates, server lifecycle, placement, backups, automation, plugins and audit activity. Outbound Go agents connect Linux nodes to the panel; the panel does not need to expose an inbound agent port. Plugins run in a sandboxed host service that has no access to the database or to Docker.


```mermaid
flowchart TB
    Browser["Browser"] --> Panel["Fledge panel"]
    Panel --> API["API"]

    API --> Database[("PostgreSQL")]
    API --> Backups["S3-compatible backups"]

    API --> Plugins["Plugin host (sandbox)"]
    Plugins -. "declared hosts only" .-> Catalogs["Modrinth and other catalogs"]
    API -. "outbound connection" .- Agent["Node agent"]
    Agent --> Node["Linux Docker node"]
    Node --> Servers["Game servers"]

    classDef app fill:#172554,stroke:#60A5FA,color:#F8FAFC,stroke-width:1.5px
    classDef data fill:#1E293B,stroke:#64748B,color:#F8FAFC
    classDef node fill:#052E2B,stroke:#34D399,color:#F0FDFA

    class Browser,Panel,API,Plugins app
    class Database,Backups data
    class Agent,Node,Servers node
    class Catalogs data
```

## What you get

| | |
|---|---|
| **Live servers** | Real CPU and memory graphs from each node's samples, disk use, and a console that keeps its history across tabs. |
| **Whole-fleet view** | One overview that lists each offline node or failed server once, with the error and a link to fix it. |
| **Placement that fits** | Servers go to a node with free capacity. Each node shows its reserved memory split per server. |
| **Files and backups** | Browser file manager and editor, drag-and-drop upload, temporary SFTP credentials, S3 backups with retention and restore checks. |
| **People and access** | Customer accounts, per-server collaborators (view, console, files, backups, manage), an audit log, and scoped API tokens. |
| **Safe by default** | Two-factor authentication required for administrators, recovery codes, and outbound-only node agents. |
| **Fast to drive** | Ctrl K searches pages and servers. Works on phones. Motion respects "reduce motion". |
| **Plugins and add-ons** | A plugin store with one-click install, permission review and a settings wizard. The bundled **Modrinth Mod Browser** and **Modrinth Plugin Browser** add a Mods or Plugins tab to matching Minecraft servers: search, dependencies, install, update, disable, remove. |
| **Autopilot** | Schedules with cron and task chains (command, wait, backup, restart), automatic restart after crashes with crash-loop protection, a notification inbox with Discord, Slack, webhook and email delivery. |
| **Templates v2** | Typed variables, import and export, versions with "update servers", extra ports, clone server. |
| **Accounts** | Passkeys, signed-in devices, email invitations and password reset, per-customer quotas, an optional admin network allow-list, audit filters and export. |
| **History and API** | CPU and memory history (1 hour to 30 days), Prometheus metrics, an OpenAPI description with an in-panel API reference. |

> **New in v0.6.1.1 "Roost":** a plugin system (sandboxed, signed, one-click) with Modrinth mod and plugin browsers, schedules and crash protection, a notification center, template v2, quotas, passkeys and more. Update the node agents to 0.6.1.1 to use add-ons. See the [release notes](docs/releases/v0.6.1.1.md). Earlier: v0.5.2.1 added automatic failover and planned moves, v0.5.1.1 kernel-enforced disk limits and agent updates from the panel.

## Quick start

### Requirements

- Docker Engine with Docker Compose v2
- 4 GB RAM recommended for the panel, database, and a small evaluation workload
- For game nodes: Linux, Docker Engine, and a reachable HTTPS panel URL
- Optional backups: an S3-compatible service reachable from the API and nodes (set up in the panel, not `.env`)

### Install with one command

Run the matching command on a fresh Docker host.

**Linux / macOS terminal**

```sh
git clone --depth 1 --branch main https://github.com/kavaliersdelikt/fledge.git fledge && cd fledge && sh ./install.sh
```

**Windows PowerShell**

```powershell
git clone --depth 1 --branch main https://github.com/kavaliersdelikt/fledge.git fledge; if ($LASTEXITCODE -ne 0) { throw 'Download failed.' }; Set-Location fledge; if (-not $?) { throw 'Could not enter the install folder.' }; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1; if ($LASTEXITCODE -ne 0) { throw 'Install failed.' }
```

The installer preserves an existing `.env`, generates private local secrets when creating one, starts Docker Compose, and waits for health checks. Windows runs the panel stack in Docker Desktop Linux-container mode.

### Start from a checkout

```sh
git clone https://github.com/kavaliersdelikt/fledge.git
cd fledge
cp .env.example .env
```

Edit `.env` and set a long URL-safe `POSTGRES_PASSWORD` and a permanent 64-character hex `ENCRYPTION_KEY` (`openssl rand -hex 32`). Then start the stack:

```sh
docker compose up --build -d
```

Open <http://localhost:3000>. The first visit creates the administrator and enrolls an authenticator for two-factor sign-in. The local Compose setup binds the panel and API to loopback and does not start a game node. Keep the encryption key safe: replacing it makes stored encrypted two-factor secrets unreadable.

```sh
docker compose ps
curl http://localhost:4000/api/health
docker compose down
```

`docker compose down -v` deletes the database and local S3 data.

## Connect a node

Prepare the node host **before** registering it in the panel. A node needs a supported Linux system with `systemd`, Docker Engine, and the Docker CLI already installed. Follow Docker's [official Engine installation guide](https://docs.docker.com/engine/install/) for your Linux distribution, then verify `sudo docker version` shows both a Client and Server. The Fledge connector installs the agent; it does not install Docker Engine.

For a local Windows evaluation, use a WSL2 Linux distro with Docker Desktop's WSL Integration enabled for that distro (Settings → Resources → WSL Integration), Linux containers selected, and systemd enabled in the distro. The PowerShell connector installs and starts the agent as a background systemd service by default; add `-Foreground` only for a temporary session. Inside the distro, confirm docker version shows both Client and Server before connecting. Do not build or run the node agent in native PowerShell: it relies on Linux system calls. See the [WSL2 node setup and PowerShell commands](agent/README.md#wsl2-development-node-on-windows). Native Windows nodes, Windows containers, and macOS node hosts are not supported.

Once Docker is installed and reachable on the node:

1. In **Nodes**, register the node's capacity and location.
2. Use **Connect a node** to create a one-time enrollment token and copy the generated connector command. Tokens expire after ten minutes and are shown once.
3. Run the connector on the node. It verifies the agent checksum, enrolls the agent, and installs a systemd service. For Windows/WSL2 evaluation, enable systemd first and run the PowerShell helper from the repository root as shown in the agent guide; it returns after starting the background service.
4. Confirm the node is connected before placing a server there.

The agent is a high-trust, root-equivalent component because it controls Docker and server files. Install it only on hosts you administer. Use HTTPS outside local development. 

New game containers keep standard input open. The live console streams Docker logs and resource samples and sends one line to container stdin; game software must support console input this way. Minecraft Containers are preset to use authenticated RCON. Containers created before this change need a configure/recreate operation before generic stdin input is available. Pterodactyl egg conversion imports environment defaults and editable variables; it does not run install scripts or translate Pterodactyl-specific startup interpolation. Review the generated image, ports, and compatibility warnings before saving.

## Plugins and add-ons

Open **Plugins** (administrators) to install, configure and turn on plugins. A plugin is a small program that runs in a WebAssembly sandbox inside the `plugins` service; the panel draws the interface and checks everything a plugin returns.

1. **Install.** The store lists the bundled plugins and, when a registry is reachable, signed community plugins. The install dialog shows what the plugin may do in plain language ("Connect to api.modrinth.com", "Add and remove files in server folders you open its tools on"). You approve it, optionally fill in its settings (with a **Test connection** button) and turn it on. Plugins from a file need *Allow community plugins* in **Plugins → Settings**.
2. **Use.** Minecraft servers whose template supports add-ons get a **Mods** tab (Fabric, Quilt, Forge, NeoForge) or a **Plugins** tab (Paper, Purpur, Folia, Spigot), chosen from the server's type and Minecraft version. Search Modrinth, open a project, pick a version, review required and optional dependencies, optionally take a backup first, and install. The node downloads the file itself and verifies the SHA-512 Modrinth publishes before writing it. Installed add-ons can be disabled (renamed to `.disabled`), pinned, updated (one or all, stable channel by default) and removed. A server restart applies the change.
3. **Trust.** *Bundled* plugins ship with Fledge. *Verified* ones carry a signature from a key you trust (**Plugins → Settings**). *Community* ones are unsigned and off by default. Updates that ask for more permissions need approval again; a plugin that keeps failing is switched off automatically. Everything is in the audit log.

Writing your own: see the [plugin guide](docs/plugins/README.md), the [reference](docs/plugins/reference.md) and the [security model](docs/plugins/security.md). Add-on support is a property of the template (**Templates → Edit → Add-on support**), so custom templates can opt in.

## Automation and notifications

- **Schedules** (server → **Automation**): run on a cron expression with a time zone, or every N minutes. A schedule is a chain of steps: send a console command, wait, take a backup, start, stop or restart. A preview shows the next five runs; every run keeps its history. Missed runs (panel down at the time) are skipped or run once, as you choose.
- **Crash protection**: restart a server that stops by itself, with growing pauses, and stop trying after too many crashes in a window (a crash loop). The last exit code, whether the kernel killed it for memory, and the end of its log are recorded and sent with the notification. Off by default for existing servers; stopping a server from the panel is never treated as a crash.
- **Notifications**: a bell with an inbox for crashes, crash loops, recoveries, almost-full disks, failed backups and verifications, failed schedules and add-on installs, node offline/online, failover, failed agent updates, new versions and plugins that were switched off. Add channels under **Settings → Notifications**: Discord, Slack, any webhook (Slack-compatible payload) or email, per event and optionally per server. Customers get a personal inbox and channels for their own servers; their webhooks must be public HTTPS URLs and their email channel can only target their own address.
- **Email** (**Settings → Panel → Email**) powers invitations, password reset and email channels. It is optional; without it, invitations return a link to pass on.

## Templates, quotas and servers

- **Templates v2**: typed variables (text, number with range, on/off, choices, patterns, secrets) with labels and help text; edit templates in the panel; every change to the image, command, ports or environment creates a version, and **Update servers** shows what would change before recreating them. Export and import templates as JSON.
- **Startup panel** (server → Settings): the image, command and environment a server starts with, with secrets hidden from customers.
- **Quotas** (**Customers**): limits on servers, memory, CPU, disk, backups and extra ports per customer, enforced when creating, resizing, backing up and cloning (administrators can override deliberately).
- **Extra ports**: add or remove additional port mappings (query, voice, RCON ...). They move with the server on planned moves and failover.
- **Clone**: copy a server's settings, and optionally its data from the newest backup, to a new server.

## Accounts and security

- **Passkeys** can be used as the second factor instead of an authenticator code (administrators keep an authenticator too). **Signed-in devices** lists browsers with last activity and lets you sign out any of them.
- **Invitations and password reset by email**; reset links work once for an hour. An administrator who resets a password still needs the authenticator.
- **Admin network allow-list** (**Settings → Panel → Security**): administrator accounts and API tokens work only from the listed addresses. The panel refuses a list that would lock out the one saving it; `ADMIN_IP_ALLOW_DISABLE=true` on the API is the break-glass switch.
- **Audit log** filters (action, person, dates, text), CSV and JSON export, and optional retention.
- The panel and API send defensive headers (CSP, frame and sniffing protection). The **API** page in the panel renders the generated OpenAPI description (`/api/openapi.json`) with curl examples.

## Backups and recovery

Turn on object storage in **Settings → Panel → Object storage**: bucket, region, endpoint and keys, with a **Test connection** button that writes, reads and deletes a probe object. The secret key is stored encrypted in the database. The endpoint must be reachable by the API and every node. (The `S3_*` variables in `.env` only seed the form before the first save; the bundled SeaweedFS service is opt-in with `docker compose --profile bundled-s3 up -d`.) Backups are verified archives, and restore stages files before swapping them into place where Linux filesystem support permits. Cross-node recovery is a manual operation: create a replacement server on another node, restore, verify the game, then update network records.

On nodes with disk limits, a running server is backed up from a frozen point-in-time copy of its volume while it keeps running (Minecraft first flushes and pauses world saving). Elsewhere the game is stopped cleanly for the archive. Neither is game-aware beyond that; validate recovery with your game and storage provider before relying on backups.

## Updating

Administrators can check and install the latest GitHub release directly from **Updates**. Select **Update panel** to start the process. The panel creates a PostgreSQL dump in `.backups/`, keeps the Compose database and S3 volumes and the existing `.env`, rebuilds the API, web and plugin host services, and checks the API and panel before reporting success (the plugin host is checked too, but a problem there only produces a warning, because the panel works without plugins). If health checks fail, it restores the previous application revision when possible. Database schema migrations are not reversed automatically, so keep an independent backup and review the release notes before updating.

The in-panel updater runs as a private Compose service and needs access to the Docker Engine socket and the project checkout. Keep the updater service on the internal Compose network; it is not published to the host. This grants the updater host-level control over Docker, so protect access to the Docker daemon and install Fledge only on a host you administer. The existing `update.sh` and `update.ps1` scripts remain available for manual recovery and clean-checkout installs.

## Documentation

- [API and configuration](api/README.md)
- [Linux node agent and WSL2 evaluation](agent/README.md)
- [Writing plugins](docs/plugins/README.md), [plugin reference](docs/plugins/reference.md) and [plugin security model](docs/plugins/security.md)
- [Release notes](docs/releases/v0.6.1.1.md)
- [Environment template](.env.example)

## Failover and server moves

Everything is managed in **Settings → Panel → Automatic failover** and watched on the **Resilience** page. Failover is off until you turn it on, and it needs object storage because servers are rebuilt from backups.

- **Automatic failover.** When a node has been silent for the configured wait (default 5 minutes), each of its servers is re-homed on a connected node with room (same location first, if you want only that, a setting), created there and restored from its newest backup. Up to *N* recoveries run at once. Servers whose newest backup is too old, or that have none, are not moved; they appear as *Waiting* with the reason (and the webhook is told), unless you allow recovery with empty data. **Data written since the last backup is lost**, so the page shows each server's backup age, and *Keep backups fresh* can take backups on a schedule (only on nodes with disk volumes, where it doesn't stop the game).
- **No double running.** When the old node returns, it is told to remove its copy of every server that now lives elsewhere (moved aside and kept for a few days by default). Optionally, *Stop servers if a node loses the panel* makes nodes stop their protected servers after most of the waiting time without contact, so a node that is cut off but still alive cannot run a server that has already been started elsewhere. Without it, a partitioned node keeps its game running until it reconnects.
- **Planned moves.** *Move* on a server (or *Empty node*) stops the server, takes a final backup, rebuilds it on another node, and only then removes the old copy: nothing is lost, with a few minutes of downtime.
- **Simulate failure** shows, for a node, where each server would go and which would stay down, without changing anything.
- **Monitoring.** The Resilience page shows readiness per server, node state with a failover countdown, recovery history with timings, and node up/down history. `GET /api/metrics` adds `fledge_failover_events{state}` and `fledge_servers_without_backup`. An optional webhook (Slack, Discord, Mattermost compatible) is notified when a node goes offline or returns and when a server is recovered, blocked or fails.
- A per-server switch turns failover off for servers you would rather recover by hand.

## Node agents, SFTP and disk limits

All of this is managed in **Settings → Panel** and **Nodes**; nothing needs `.env` or a restart.

- **Agent updates.** Nodes report their agent version. When a newer release is published (GitHub release of your repository, or your own download URL with `VERSION`, `SHA256SUMS` and `fledge-agent_linux_{amd64,arm64}`), **Nodes** shows *Update to x.y.z.w*; **Update N agents** updates them all, and *Update node agents automatically* does it unattended. The agent downloads the binary, verifies its SHA-256, runs it once to confirm its version, keeps the old binary as `fledge-agent.prev`, swaps and re-executes itself, then confirms to the panel. A new version that fails to start three times is rolled back and not retried. Agents older than 0.5.1.1 cannot update themselves; reconnect them once with the connector.
- **Disk limits.** Each server's data lives in a sparse ext4 image sized to its disk allowance and loop-mounted into the node's data directory, so the kernel returns *no space left* to the game, SFTP and the panel alike. Growing a limit is applied live where the kernel allows it; shrinking (or growing on hosts that refuse online resizing) briefly stops the server. The panel refuses to shrink below current use. Usable space is about 2 % smaller than the allowance because of filesystem metadata. Existing servers move into a volume the next time they are restarted. The node needs root, loop devices and `e2fsprogs`; otherwise it falls back to soft limits (or refuses to run servers, if you chose *Require enforcement*).
- **SFTP.** Turn it on or off and choose its port in the panel; agents apply it within seconds. Set a node's *Public address* so credentials show the right host.
- **Allowed images.** One prefix per line; applied to the API and all agents.

## Known limits

- Plugins: WebAssembly isolation reduces risk but is not a formal guarantee, and Fledge does not scan downloaded mod or plugin files: a checksum proves a file is the one a catalog named, not that it is safe. The registry ships without a built-in trusted key; add the keys you trust. Add-ons need node agents 0.6.1.1 or newer. The plugin interface is limited to catalogs and event hooks in 0.6; custom plugin pages are not available yet. See the [security model](docs/plugins/security.md).
- Automation: schedule steps are queued for the node and run in order, but a step does not wait for the game to finish a command. A run interrupted by an API crash may repeat its current step. Crash protection reacts to the container's exit, not to a game that hangs without exiting.
- Passkeys were verified with a software authenticator in tests, not with every browser and security key; keep your authenticator app and recovery codes.
- Disk limits cover each server's data directory. The container's writable layer (anything a game writes outside the data mount) is not limited. Volumes need a Linux node with root, loop devices and `e2fsprogs`.
- Failover is backup-based, not replication: a recovered server loses everything since its newest backup, and recovery takes the time of a restore. It does not detect a hung game on a healthy node, a node that is reachable but broken, or an outage of the panel itself. Without *Stop servers if a node loses the panel*, a node that is cut off from the panel but still running keeps its game running until it reconnects, so the same game may run on two nodes in that window (players can only reach one address). A failed recovery leaves the server on the new node in a failed state with the old data kept aside, to be retried by hand. Live migration without downtime is not implemented.
- Snapshot backups are crash-consistent: they capture the volume as if power were cut at that instant, with a world-save flush for Minecraft. Other games depend on their own crash recovery. Without a volume, backups stop the game cleanly and depend on it honouring Docker's stop signal. Scheduled verification checks archive integrity and safe extraction; it does not boot a game.
- Without object storage, file transfers are spooled on the API host (`TRANSFER_DIR`, a Compose volume by default). Several API replicas then need that directory shared, or object storage turned on. Transfers are limited to 1 GiB; the text editor to 1 MiB.
- Console events and node ownership are routed through PostgreSQL for multiple API replicas, but a sustained multi-replica load and failover drill has not been run.
- Pterodactyl conversion copies portable fields, the startup command (with `{{VAR}}` turned into `${VAR}`, plus `SERVER_MEMORY`, `SERVER_PORT`, `SERVER_IP`) and the stop command. Install scripts and Pterodactyl daemon images are not executed; review imported templates.
- Verified against a real Docker host: kernel limits, grow/shrink, legacy migration, uploads and downloads, agent self-update with checksum refusal, snapshot backup and restore, an S3-protocol test server, and (v0.5.2.1) automatic failover, planned moves, blocked recovery, stale-copy eviction and webhooks across two agents with separate Docker daemons. Not yet validated: real AWS S3 retention, Valheim boot, failover across physical hosts and with a real game (it was exercised with two agents and two Docker daemons on one machine), SFTP with third-party clients on a dedicated node, and agent rollback of a binary that crashes after starting (covered by unit tests only). Windows Docker Desktop is for local Linux-container and WSL2-agent evaluation; native Windows services and Windows containers are unsupported.
- The API has shared request throttles, one-time account recovery codes, admin-only Prometheus metrics, and an updater that restores application code if its health check fails. These controls do not replace a formal production security review. Database migrations are not automatically reversed; account recovery requires previously saved recovery codes; and the Linux agent still has root-equivalent Docker access. Rootless operation, load testing, external monitoring, and credential-rotation operations remain unvalidated.


## Development checks

```sh
# API (needs PostgreSQL; the integration tests create their own throw-away databases,
# set TEST_DATABASE_URL to a superuser connection such as postgres://user:pass@localhost:5432/postgres)
cd api && npm ci && npm run check && npm run test:unit && npm run test:cors && npm run test:updates && npm run test:templates
cd ../plugins/host && npm ci && npm run check && npm test
cd ../tools && npm ci
cd ../../api && npm run test:plugins && npm run test:templates-v2 && npm run test:fit && npm run test:autopilot && npm run test:accounts

# Web
cd ../web && npm ci && npm run check && npm run build

# Agent
cd ../agent && go test ./... && go vet ./... && go build ./...

# Install and update scripts
cd .. && sh tests/install-smoke.sh && sh tests/update-smoke.sh && sh tests/update-flow-smoke.sh && sh tests/connector-smoke.sh
```

The disposable API smoke test is in `tests/api-smoke-disposable.ps1`; it creates and removes a uniquely named PostgreSQL test container/database. Set `FLEDGE_SMOKE_S3=true` and provide `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, and a host-reachable `S3_ENDPOINT` to include streamed object and retention checks against an S3-compatible test bucket. It writes only unique `smoke/` objects and cleans up its fixtures. Do not point smoke tests at a production database or bucket.

## Community

<div align="center">

<a href="https://discord.gg/gu49ZF6tQh"><img src="https://img.shields.io/badge/Discord-Come_say_hello-5865F2?style=for-the-badge&amp;logo=discord&amp;logoColor=white" alt="Join the Discord" /></a>
<a href="https://github.com/kavaliersdelikt/fledge"><img src="https://img.shields.io/badge/Like_Fledge%3F-Star_on_GitHub-F59E0B?style=for-the-badge&amp;logo=github&amp;logoColor=white" alt="Support Fledge with a star on GitHub" /></a>

</div>

| Want to… | Start here |
| --- | --- |
| Ask a setup question or share your server | [Join Discord](https://discord.gg/gu49ZF6tQh) |
| Report a bug | [Open an issue](https://github.com/kavaliersdelikt/fledge/issues/new) with reproduction steps and relevant logs |
| Suggest an improvement | [Share an idea](https://github.com/kavaliersdelikt/fledge/issues/new) and describe the problem it would solve |
| Contribute code | Start with the [open issues](https://github.com/kavaliersdelikt/fledge/issues) and [development checks](#development-checks) |

Please redact credentials, enrollment tokens, and backup URLs before sharing logs or screenshots.

## Project status

Contributions and issue reports are welcome; please include reproduction steps and redact credentials, enrollment tokens, and backup URLs. 
