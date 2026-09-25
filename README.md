# Navrylo

A minimal, dark, English-language control panel for multi-node game hosting. This repository contains a connected Next.js panel, PostgreSQL-backed Fastify API, and outbound Go/Docker node agent. **Beta implementation, not a production-certified hosting product.** It does not contain mock API handlers or demo data. Operations talk to the real API; the node agent runs real Docker operations when installed on Linux nodes.

## Start locally

Prerequisites: Docker Compose for the panel/API/database; for actual game servers, a Linux Docker host with the Docker Engine and Docker CLI. For backups, supply external S3-compatible storage reachable from the API and *every* node (and the browser for downloads). Docker Desktop on Windows can run the panel/API/database as Linux containers and can be used for a **development or single-host evaluation** node by running the agent inside a WSL2 Linux distro. That Windows/WSL2 setup is not a supported production node; production nodes should be dedicated Linux hosts. See [Windows + Docker Desktop / WSL2](#windows--docker-desktop--wsl2-development) and [agent instructions](agent/README.md).

```sh
cp .env.example .env
# Edit .env: choose a long URL-safe POSTGRES_PASSWORD and set ENCRYPTION_KEY
# Generate ENCRYPTION_KEY exactly once: openssl rand -hex 32

docker compose up --build -d
# Open http://localhost:3000
# API health: http://localhost:4000/api/health
```

Local Compose binds panel/API to loopback by default and **does not run a game node**. First visit: create the provider account in the bootstrap form, set up TOTP using an authenticator, then sign in. Keep the encryption key permanently: changing it invalidates encrypted 2FA secrets. Customer accounts are created in the provider UI; one-time temporary passwords must be transferred securely. To shut down: `docker compose down`. `docker compose down -v` **destroys the database**.

Without Docker Compose, use PostgreSQL 15+, `cd api && npm ci && npm start` with `DATABASE_URL`, `ENCRYPTION_KEY` and `WEB_ORIGIN`; separately `cd web && npm ci && NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev`. Node.js 20+ is required. See [API setup](api/README.md) and [panel setup](web/README.md).

### Install assistant (Windows, macOS and Linux)

Open `/install` on a running Navrylo panel. It defaults to `kavaliersdelikt/navrylo` and branch `main`; choose Windows, macOS, or Linux and copy the generated one-line command. The commands use PowerShell on Windows and a POSIX shell on macOS/Linux. They clone the selected source revision and run `install.ps1` or `install.sh`; those scripts verify Docker Engine/Compose, create a new `.env` with cryptographically random secrets only when one does not already exist, build/start Compose, and wait for the API and panel health checks. They never overwrite an existing `.env`; inspect the source and repository before running commands. Since the repository is private during initial setup, GitHub authentication is required to clone it. Once public, the command works for unauthenticated downloads. Docker Desktop is required on Windows/macOS; Windows uses Linux containers. This is a local evaluation installer, not an unattended production installer.

The project repository is `https://github.com/kavaliersdelikt/navrylo`. Set `NEXT_PUBLIC_GITHUB_REPOSITORY=owner/repository` in `.env` before building the web image to override the install and node-connector defaults. `sh install.sh --check` and `./install.ps1 -CheckOnly` verify prerequisites without starting services.

To publish one-line node connectors, push a version tag such as `v0.1.0`. The `release-agent.yml` workflow builds Linux `amd64` and `arm64` binaries, publishes them with `SHA256SUMS`, and the node connector verifies the downloaded binary before installation. Private GitHub releases and raw connector scripts require authentication not embedded in the one-line command; make the repository public before distributing that connector, or use an authenticated internal distribution process. Create node capacity, generate a ten-minute token, copy the platform command and token, then run the command on the node. Linux installs a systemd service. Windows connects through WSL2 and runs the Linux agent in the foreground. The token is entered at a hidden terminal prompt rather than included in shell history. A new token replaces that node's current credential, with a confirmation for connected agents. Native Windows agents and macOS nodes are not supported; macOS is supported for running the panel stack.

### Panel updater

Administrators can open **Updates** in the panel to check the latest stable GitHub release, view its notes, and copy the host update command. For a public repository, the API checks GitHub anonymously. For a private repository, configure `GITHUB_TOKEN` in the API environment with a fine-grained, read-only token for repository contents/metadata; keep it server-side and never put it in the web build. The API caches successful checks for five minutes. The panel does not execute host commands: Docker Compose must be updated by a host operator.

From a clean Git checkout on the Compose host, run `sh ./update.sh` on Linux/macOS or `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\update.ps1` on Windows. An optional version argument pins a tag (for example `sh ./update.sh v0.1.0`). The script fetches stable version tags, writes a restricted PostgreSQL SQL backup under `.backups/`, records the target version in `.env`, checks out that version, rebuilds the Compose services, and checks the API and panel. It keeps the seven most recent database dumps. If the new code fails health checks, it restores the prior `.env` version, checks out the previous code, and rebuilds it. Schema migrations run during API startup and are not automatically reversed; verify the SQL backup before deploying upgrades. Set `API_HEALTH_URL` and `WEB_HEALTH_URL` if the local health URLs differ. Run with `--check` / `-CheckOnly` for a non-mutating prerequisites check.

### Windows + Docker Desktop / WSL2 development

This is a local development/single-host evaluation path only. Docker Desktop must be in **Linux containers** mode and use its WSL2 engine. Compose still starts the panel, API and database as Linux containers. A game node is not a Windows service: build the Linux agent with the PowerShell helper below, then install and run it **inside a WSL2 Linux distro** where Docker Desktop WSL Integration exposes the Docker CLI and engine. The WSL distro and Docker Desktop engine share the same Windows machine, so this is not a separate node, a production deployment, or evidence of real Linux-host behavior. Do not use Windows containers for Navrylo's Linux images or agent.

1. Install/update WSL2 and a distro from PowerShell (administrator may be required), then verify it is version 2:

   ```powershell
   wsl --install -d Ubuntu-24.04
   wsl --update
   wsl --set-default-version 2
   wsl --list --verbose
   ```

   Complete the Ubuntu first-run user setup. Install Docker Desktop for Windows; in **Settings → General**, enable **Use the WSL 2 based engine**; in **Settings → Resources → WSL Integration**, enable the Ubuntu distro. Leave Docker Desktop set to **Linux containers**. Restart Docker Desktop and the distro if you changed these settings. In Ubuntu, check that `docker version` displays both Client and Server. Do not install a separate `dockerd`/`docker.io` engine in the distro.

2. From PowerShell at this repository checkout, create `.env` from the example, edit its values, and start the Compose stack. Generate the key in Ubuntu (`openssl rand -hex 32`) if OpenSSL is not installed on Windows.

   ```powershell
   Copy-Item .env.example .env
   # Edit .env in a text editor: POSTGRES_PASSWORD and ENCRYPTION_KEY are required.
   docker compose up --build -d
   Invoke-RestMethod http://localhost:4000/api/health
   ```

3. Use the panel at `http://localhost:3000` to bootstrap the provider, enroll TOTP, and create a node. Keep the node's one-time enrollment token handy (10-minute expiry). In Ubuntu, install Go 1.19+ if needed (`sudo apt update && sudo apt install -y golang-go ca-certificates curl`), then from PowerShell build the Linux binary:

   ```powershell
   .\agent\build-agent-wsl.ps1 -Distro Ubuntu-24.04 -CheckDocker
   ```

   The helper stages the agent source in the distro's Linux filesystem, builds a Linux/WSL-architecture binary, and writes it to `agent\dist\navrylo-agent-linux` by default. `-CheckDocker` verifies that WSL's Docker CLI can reach the Docker Desktop Linux engine. The output is not a Windows `.exe`. From an Ubuntu shell in the Windows checkout, install it into the distro (replace the Windows checkout path as appropriate):

   ```sh
   sudo install -m 0755 "$(wslpath -u 'C:\path\to\navrylo\agent\dist\navrylo-agent-linux')" /usr/local/bin/navrylo-agent
   ```

   Then follow [agent configuration and enrollment](agent/README.md#wsl2-development-node-on-windows). For a local-only Compose API, use HTTP only with `ALLOW_INSECURE_HTTP=true`; do not use that setting in a non-local deployment.

4. Before relying on the setup, verify API reachability **from Ubuntu**, `docker version` from the same distro, server creation, container health, file ownership, stop/start, and (if configured) backup/restore. The Compose API defaults to a loopback-only Windows port. Depending on Windows/WSL networking mode, WSL may or may not reach that port at `localhost`; test it from the distro first. If it cannot, the agent section explains how to discover the Windows host address and the local-only, firewall-sensitive `API_BIND` adjustment. Game ports are published by Docker Desktop onto the Windows host; test TCP/UDP and Windows Firewall behavior on the exact machine/network. Do not expose this evaluation stack or game ports to the Internet without a separately designed and tested deployment.

Keep the repository and runtime game data in a WSL Linux filesystem where possible; avoid `/mnt/c` for live server data due to Linux ownership, permissions, and file-I/O differences. The helper stages compilation on the Linux filesystem, but its output is intentionally placed under the Windows checkout for convenient access. Docker Desktop/WSL memory and CPU limits, virtual-disk free space, bind-mount behavior, port forwarding, and reported node capacity differ from a dedicated Linux server; use conservative capacity and verify them. This environment does not validate actual game-server boot or reliable public UDP reachability.

### Connect two actual game nodes

1. Build/install the Go agent on each supported Linux Docker host per [agent instructions](agent/README.md). Go 1.19+ is required for building it. Keep the host's Docker socket private. The Windows/WSL2 helper above is for development/evaluation, not the production-node procedure.
2. In **Nodes**, add capacity/location for each host. Generate each node's one-time enrollment token; it expires after 10 minutes.
3. Set `API_URL`, `NODE_ID`, `ENROLLMENT_TOKEN`, `DATA_ROOT` and `CREDENTIAL_FILE` in that node's `/etc/navrylo-agent.env`; start the systemd unit. After enrollment, remove `ENROLLMENT_TOKEN` from the environment and restart. Use HTTPS in all non-local installations.
4. Confirm both nodes show connected and their reported free disk is healthy. Create a customer, then a Minecraft Java or Valheim server on a selected or automatically placed node. The UI links to the durable job result and node incident state.
5. For backups, configure `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_ENDPOINT` on the API. The S3 endpoint must be HTTPS and resolvable/reachable from **all nodes and browsers**. Create a backup; for cross-node recovery, create a replacement server on the healthy node, restore the backup there with explicit confirmation, then update DNS/port records. Do not assume live migration.

The agent is a **high-trust root-equivalent component**. The supplied systemd unit runs as root to manage Docker and file ownership. Only deploy it on dedicated nodes you administer. Allowlist trusted images on both API and agent; the beta templates are not validated on actual game hosts in this delivery.

## Working feature surface

- Provider/customer login, required provider TOTP, sessions and scoped provisioning tokens; admin/customer separation and collaborator grants.
- Multiple enrolled outbound agents with heartbeat and disconnected-node state; capacity-aware placement, RAM/CPU/disk **reservations**, TCP/UDP port uniqueness, node draining, durable agent jobs and audit events.
- Minecraft Java and Valheim template definitions; server lifecycle, suspensions, configurable resources, limited editable startup variables, authenticated live WebSocket console, and Minecraft RCON commands.
- Docker-reported per-server CPU/RAM samples in the live view and heartbeat records; no per-server disk-usage enforcement.
- Per-server browser files with path confinement, text edit, streamed upload/download (up to 1 GiB per transfer), folders and ZIP extract; text editor content remains capped at 1 MiB.
- Optional S3 backup creation/download/deletion, configurable retention (off by default), archive integrity verification, and staged atomic restore where Linux filesystem `renameat2(RENAME_EXCHANGE)` is supported; manual restore to another node.
- Responsive dark English-language panel with real API states, confirmation prompts and role-aware controls. No native billing, reseller hierarchy, live migration, or highly available control plane.

**Current limitations:** SFTP is opt-in on each agent (`SFTP_LISTEN`) and needs an operator-reachable SSH port. Browser transfer and SFTP writes enforce a logical per-server disk allowance, but the game container itself can still exceed that allowance; this is not a filesystem hard quota. The agent reports per-server disk usage by scanning its files. Automatic stateful failover/live migration is not implemented; use a manual restore to another node. Backups stop a running container gracefully and require exit code 0 before archiving, but they are not atomic filesystem snapshots and game-specific consistency still needs real Valheim and dedicated-host validation. Scheduled restore verification checks and extracts the archive in temporary storage; it does not boot the game. The console broker stores short-lived events and connection leases in PostgreSQL for cross-process routing; production load/restart and multi-host tests remain. Local SeaweedFS was used here; real AWS S3 retention has not been validated. A separate two-host recovery drill, native Windows agents/Windows containers, formal production security review, distributed tracing/alerts, **automatic DB migration rollback**, and rootless agent operation remain outstanding. Code updates include health checks and automatic application-code rollback, but they do not reverse schema migrations. See [API limitations](api/README.md), [panel limitations](web/README.md), and [SFTP status](SFTP_STATUS.md).

## Validation and release gate

Validation on the current Windows + Docker Desktop + WSL2 machine: API and panel type checks and optimized web builds passed; the API smoke suite passed **187 assertions** against a new disposable PostgreSQL container; the focused updater API test passed admin access control, release parsing/comparison, and caching. Linux-container Go tests, vet and build passed; installer, connector, updater, and Linux `amd64`/`arm64` release/checksum smoke tests passed. Native Windows PowerShell installer and updater preflight tests passed, including private `.env` ACL checks. The API and web Docker images built and are running; `/api/health`, the `/install` flow, and the admin Updates page were checked in the browser. The existing WSL2 node remained connected after the panel rebuild. Earlier local integration also exercised Minecraft Java containers, resource samples, RCON and SeaweedFS backup/restore. The current 187-assertion API run did not enable the optional S3 cases. This is single-machine evidence, not a two-host recovery drill, external AWS S3 retention test, Valheim boot validation, native Windows agent/containers test, or production deployment. The GitHub repository is private and has no release tag yet, so anonymous connector asset downloads and a live GitHub Release lookup are not available until a release is published (or a read-only `GITHUB_TOKEN` is configured on the API).

Before any paying-customer deployment, at minimum:

- Run `npm ci && npm run check` in `api` and `web`, `npm run build` in `web`, `go test ./... && go build ./...` in `agent`; run the smoke test against an **empty disposable** PostgreSQL database and API (`TEST_API_URL`, `DATABASE_URL`) only.
- Build the images with `docker compose build`; put HTTPS and a trusted proxy/edge rate limit in front. Test secure SameSite cookies and cross-origin behavior on your actual domains.
- Boot and exercise Minecraft and Valheim with **two real Linux nodes**; test concurrent placement, node disconnect/reconnect, privileged Docker boundary, customer isolation, and volume permissions.
- Configure real S3 and perform create → download → restore onto the *other node* → boot and inspect world data. Test backup corruption and interrupted restore; capture recovery and downtime procedures.
- Add versioned migrations, deployment rollback, secret rotation, hard filesystem quotas, automatic failover, game boot verification, AWS S3 retention and two-host recovery drills, formal security review, production alerting/tracing, and rootless agent support. Current schema is additive SQL applied at startup; back up DB before upgrades.

This repository contains ignored secrets, lockfiles, example configuration, container definitions and CI checks. It is **not production-ready** until the release gate and remaining features are addressed. No secrets are bundled. No license has been selected; add one before making the repository public or accepting external contributions. The project name is provisional: check trademarks and domain availability before launch.

## Repository map

- `web/` — Next.js/React panel
- `api/` — Fastify API and PostgreSQL-backed scheduler
- `agent/` — Go outbound Docker node agent + systemd unit; includes a Windows PowerShell helper that builds the Linux binary inside WSL2
- `db/schema.sql` — initial schema (not a full migrations framework)
- `compose.yaml` — local evaluation stack only
- `update.sh`, `update.ps1` — host-side, backup-first tagged release updater
- `.env.example` — configuration template; copy to untracked `.env`

No license has been selected. Add the license you want **before** publishing or accepting external contributions.


