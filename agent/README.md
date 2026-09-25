# Fledge outbound Docker node agent

The agent is a **Linux** Go program. It requires Linux, Go 1.19+ to build, Docker Engine and the `docker` CLI on each node. It does not listen on a port. It polls the control plane over HTTPS for durable jobs, heartbeats every 10 seconds, and initiates an authenticated outbound WebSocket for on-demand Docker logs and CPU/RAM samples. It executes leased jobs with the local Docker CLI and stores successful destructive-job receipts in `DATA_ROOT/.jobs` for idempotent replay after network loss. It stores its node credential in a mode-0600 file. The Docker socket is **root-equivalent**. The supplied systemd unit runs as root so the agent can read/write game files after images change bind-mount ownership; protect the host, restrict network egress, and rotate enrollment credentials when compromised. A non-root Docker-group or rootless setup is possible only after testing image UID/GID and volume permissions on your nodes; it is not validated here.

**Windows is not a native agent target.** The agent uses Linux syscalls (including `/proc` and `statfs`) and the supplied service is a Linux systemd unit. Do not build a Windows `.exe`, install it as a Windows service, or use Windows containers. Docker Desktop on Windows can be used for local development/single-host evaluation only: its Docker engine must be in Linux-container mode, and the agent must be built and run inside a WSL2 Linux distro with Docker Desktop WSL Integration. This WSL2 arrangement is not a supported production node and has not been validated on Windows; use dedicated Linux hosts for production.

On Linux, build and install as usual:

```sh
cd agent
go build -o navrylo-agent .
# Install securely as /usr/local/bin/navrylo-agent and provision writable /var/lib/navrylo.
```

## WSL2 development node on Windows

Use this only to evaluate a panel and one local game-server node. The panel/API/database still run in the repository's Docker Compose **Linux containers** under Docker Desktop. The WSL agent controls Docker Desktop's shared Linux engine; it is not a separate host, and there is no native Windows service support.

1. In an elevated PowerShell if required, install/update WSL and a distro, and check it uses WSL version 2:

   ```powershell
   wsl --install -d Ubuntu-24.04
   wsl --update
   wsl --set-default-version 2
   wsl --list --verbose
   ```

   Install Docker Desktop for Windows. In **Settings → General**, turn on **Use the WSL 2 based engine**. In **Settings → Resources → WSL Integration**, enable the distro you will use (for example, Ubuntu-24.04), then restart Docker Desktop and the distro. Ensure Docker Desktop is running in **Linux containers** mode. In that distro, install Go 1.19+ and basic tools if needed:

   ```sh
   sudo apt update
   sudo apt install -y golang-go ca-certificates curl
   go version
   docker version
   docker info
   ```

   `docker version` must show both Client and Server. The server is Docker Desktop's Linux engine. Do not install a second `dockerd` or distro `docker.io` engine; if the Docker command/server is missing, fix Docker Desktop WSL Integration instead. Check `sudo docker version` too if you intend to run the agent as root.

2. Start the API/panel/database from PowerShell at the repository root, following the root [Windows + Docker Desktop / WSL2 instructions](../README.md#windows--docker-desktop--wsl2-development). Create the node from the provider UI and copy its node UUID and fresh enrollment token. The token expires after 10 minutes. Confirm that the API health endpoint is reachable **from the WSL distro**, for example:

   ```sh
   curl -fsS http://localhost:4000/api/health
   ```

   If that fails, try the Windows host address visible from WSL NAT networking:

   ```sh
   WIN_HOST=$(ip route show default | awk '{print $3; exit}')
   printf 'WSL default gateway: %s\n' "$WIN_HOST"
   curl -v "http://${WIN_HOST}:4000/api/health"
   ```

   WSL `localhost`/host networking and Docker Desktop port forwarding vary by Windows/WSL networking mode. The Compose API port is loopback-only by default, so a request via the WSL gateway may not work with the default bind. Only for isolated local development, if necessary, set `API_BIND=0.0.0.0` in the root `.env`, recreate the API (`docker compose up -d --force-recreate api`), and retry using the Windows host address. This can expose the API on Windows interfaces: keep Windows Firewall active, restrict the port to the local/WSL environment, and never forward it to the Internet. Restore loopback binding when no longer needed. If none of these addresses works, do not weaken firewall rules blindly; verify the Windows host IP, Compose port mapping, Docker Desktop state, and Windows Firewall first.

3. From PowerShell in the Windows checkout, build the binary inside WSL (the script stages source under the distro's Linux filesystem, then places the result at `agent\dist\navrylo-agent-linux`):

   ```powershell
   .\agent\build-agent-wsl.ps1 -Distro Ubuntu-24.04 -CheckDocker
   ```

   The helper auto-selects WSL's `amd64` or `arm64` Go target. Use `-Architecture amd64` or `-Architecture arm64` only if you intentionally need to override the target to match the Docker Desktop Linux engine. If Go is missing, install Go 1.19+ in that distro. The helper is for builds from a local Windows checkout accessible to WSL (normally a drive under `/mnt/c`); for unusual/UNC repo paths, keep the checkout on a local drive or build from Linux directly.

   From an Ubuntu shell, install the output into that same distro; replace the example checkout path with the real Windows checkout:

   ```sh
   sudo install -m 0755 "$(wslpath -u 'C:\path\to\navrylo\agent\dist\navrylo-agent-linux')" /usr/local/bin/navrylo-agent
   ```

   The result is an ELF Linux executable, not runnable directly by PowerShell. Do not copy the agent into a Windows service directory or start it from Windows.

4. Run the agent interactively in Ubuntu for local evaluation. Use the node UUID and fresh one-time enrollment token from the UI. Replace the placeholders and API URL with the address that succeeded in step 2:

   ```sh
   sudo env \
     API_URL='http://localhost:4000' \
     NODE_ID='<node-uuid>' \
     ENROLLMENT_TOKEN='<one-time-token>' \
     DATA_ROOT='/var/lib/navrylo/servers' \
     CREDENTIAL_FILE='/var/lib/navrylo/agent.credential' \
     ALLOW_INSECURE_HTTP='true' \
     ALLOWED_IMAGE_PREFIXES='itzg/minecraft-server:,ghcr.io/lloesche/valheim-server:' \
     /usr/local/bin/navrylo-agent
   ```

   If you use the Windows host IP instead, put that full URL in `API_URL`. `ALLOW_INSECURE_HTTP=true` is only for this local HTTP evaluation; deployment requires HTTPS. The service runs in the foreground and stops with Ctrl+C. On successful enrollment the one-time token is stored in the protected credential file; remove `ENROLLMENT_TOKEN` from subsequent launches. Do not put reusable credentials in source control or share logs/screenshots containing them. Since the supplied Linux systemd unit is not a Windows service, this example does not install or promise automatic startup in WSL.

   Running as root matches the supplied Linux service's ability to manage container-owned files, but first make sure `sudo docker version` reaches the same Docker Desktop engine. If only the normal WSL user can access Docker, you may run the binary as that user with a data root in the distro's home directory for a disposable test; image ownership changes may then cause file-access failures. Do not make the Docker socket world-writable to work around this. Validate server creation, file operations, restart, and deletion before using any WSL node for anything important.

5. In the panel, check that the node is connected and has plausible free disk/resource readings. Create a disposable Minecraft or Valheim server and verify its logs, game-port reachability, and file permissions; if testing backups, complete a real create/download/restore cycle. Docker Desktop publishes the container ports onto the Windows host, but inbound LAN/Internet TCP or UDP reachability depends on Docker Desktop, WSL networking, Windows Firewall, and router configuration. Ports already used on Windows may collide. Do not assume public reachability or a stable public node address; do not expose game ports until they have been independently tested and secured.

**WSL caveats:** Keep `DATA_ROOT` in the distro's Linux filesystem (such as `/var/lib/navrylo/servers`), not `/mnt/c`; Windows-mounted paths have different ownership/permission behavior and typically poorer small-file I/O. The agent passes bind-mount paths to Docker Desktop's Linux engine, so validate mounts and ownership on the specific Docker Desktop/WSL versions used. The agent's `/proc` memory/CPU and `statfs` disk readings reflect the WSL/virtual-disk environment, not necessarily the Windows host's full available capacity; Docker Desktop and WSL2 resource limits affect actual capacity. WSL virtual-disk growth/free space is not a quota, and disk reservations are not enforced quotas. Console polling, live backup consistency, and Windows host port forwarding also retain their normal beta limitations. None of these caveats are a substitute for testing on supported dedicated Linux nodes.

## Linux node configuration and enrollment

As a provider admin, create the node via `POST /api/nodes` with its configured capacity and location, then `POST /api/nodes/:id/enrollment` to obtain the 10-minute one-time token. On the Linux node set:

```text
API_URL=https://panel.example.com
NODE_ID=<the UUID returned by POST /api/nodes>
ENROLLMENT_TOKEN=<one-time enrollment token; remove from environment after enrollment>
DATA_ROOT=/var/lib/navrylo/servers
CREDENTIAL_FILE=/var/lib/navrylo/agent.credential
ALLOWED_IMAGE_PREFIXES=itzg/minecraft-server:,ghcr.io/lloesche/valheim-server:
```

Run `navrylo-agent` once to exchange the token and save the credential. Future restarts read `CREDENTIAL_FILE`; remove `ENROLLMENT_TOKEN` from the service environment. If re-enrolling, issue a fresh enrollment token in the panel, remove the old credential file on this node, provide the fresh token, and restart; issuing the token immediately revokes the old credential. `ALLOW_INSECURE_HTTP=true` permits HTTP *only for local/development use*. Use HTTPS with a valid CA certificate in deployment. The S3 endpoint configured on the control plane must be reachable from this node, since the agent PUTs/GETs via signed URLs.

### One-line panel connector

The admin **Nodes → Connect a node** assistant can generate a platform command after you register node capacity. It shows the short-lived enrollment token separately; paste it only when the connector asks in a hidden terminal prompt. The token is not placed in shell history, command arguments, or the service environment. The connector downloads the latest GitHub release for Linux `amd64` or `arm64`, checks it against that release's `SHA256SUMS`, exchanges the token, and stores the resulting node credential in a mode-0600 file. A public GitHub repo and a published `v*` release are required; this source checkout has no configured remote, so enter the actual `owner/repository` in the panel.

On dedicated Linux hosts it installs `/usr/local/bin/navrylo-agent` and a systemd service. On Windows, the generated PowerShell helper forwards the operation into a selected WSL2 distro and runs the Linux agent in the foreground. Install Docker Desktop's WSL integration first and make sure the API URL is reachable from that distro. Closing the WSL terminal stops the evaluation agent. This does not install a native Windows service. macOS is supported for running the panel stack but not as a node host.

Each server gets a Docker container named `nvr-<uuid>` and local data directory `DATA_ROOT/<uuid>`. Minecraft mounts that directory at `/data`; Valheim at `/config`. Docker memory/CPU/PID limits and no-new-privileges are set (Docker's default capabilities remain so official images can initialize and chown their mounted data); Docker's own `-p` publishes the required TCP/UDP ports. **Disk reservations are not enforced quotas.** Backups stage a tar.gz file under `DATA_ROOT` then upload it to S3, so budget disk headroom at least as large as the compressed archive. Valheim password is generated per server by the API and visible to the server owner via server detail. Console commands are implemented only for Minecraft through `rcon-cli`; Valheim has logs but not remote command input. Custom template startup commands run via `/bin/sh -c` inside the image and require an image with a shell. Ensure trusted image prefixes match on API and agent; unknown images are rejected.

`go test ./...` exercises path confinement/ZIP traversal and a local HTTP backup/restore round trip. There is **no end-to-end real-Docker or S3 test in this repository**. Validate both official templates and recovery on two real nodes before production use. Recovery after a lost node is manual: create a new server elsewhere, restore its S3 backup, and adjust DNS/ports. Existing containers keep running while the control plane is down; jobs wait.


## Optional SFTP

Set `SFTP_LISTEN=127.0.0.1:2022` when launching the agent to enable SSH/SFTP, or bind a private node interface and protect that port with host firewall rules. The agent creates a persistent Ed25519 host key beside `CREDENTIAL_FILE` by default (`SFTP_HOST_KEY` overrides the path); back this file up and restrict access. In the panel's Files tab, request a connection password for the selected server. Use the node's reachable SFTP hostname/port, that server UUID as username, and the one-time password. Credentials expire after 15 minutes. Each new panel credential replaces the prior access for that account/server. The agent permits SFTP file operations only, checks permissions again every 20 seconds, limits concurrent SSH sessions, and keeps paths confined to the server data directory. SFTP write checks are a logical allowance; they do not impose a host filesystem quota on a running game process. The feature has Go tests for a real SSH/SFTP subsystem flow, but has not been field-tested through a dedicated Linux node firewall or third-party SFTP client.
