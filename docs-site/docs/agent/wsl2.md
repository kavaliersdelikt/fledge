---
title: WSL2 evaluation node
---

# WSL2 evaluation node (Windows)

::: warning For evaluation only
Use this to try a panel and one local game-server node on a Windows machine. It is **not** a supported production node
and has not been validated on Windows. Use dedicated Linux hosts for production. Native Windows services, Windows
containers and macOS node hosts are unsupported.
:::

The panel, API and database run in the repository's Docker Compose **Linux containers** under Docker Desktop. The WSL
agent controls Docker Desktop's shared Linux engine; it is not a separate host.

## 1. WSL2 and Docker Desktop

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
wsl --set-default-version 2
wsl --list --verbose
```

In Docker Desktop: **Settings → General → Use the WSL 2 based engine**, and **Settings → Resources → WSL Integration**
for your distro; restart Docker Desktop and the distro. Linux containers must be selected.

Enable systemd in the distro (`/etc/wsl.conf`):

```ini
[boot]
systemd=true
```

Then `wsl --shutdown` in PowerShell and reopen Ubuntu. `ps -p 1 -o comm=` should print `systemd`. The password `sudo` asks
for is your Linux password, not your Windows one.

Inside the distro:

```sh
sudo apt update
sudo apt install -y golang-go ca-certificates curl
go version
docker version      # Client AND Server (Docker Desktop's engine)
```

Do not install a second `dockerd` in the distro.

## 2. Panel reachable from WSL

Start the panel from PowerShell at the repository root, create the node in the UI and copy its UUID and a fresh token
(valid 10 minutes). Check that the API answers from inside WSL:

```sh
curl -fsS http://localhost:4000/api/health
```

If not, try the Windows host's address from the WSL gateway:

```sh
WIN_HOST=$(ip route show default | awk '{print $3; exit}')
curl -v "http://${WIN_HOST}:4000/api/health"
```

The Compose API port is loopback-only by default. Only for isolated local development, you may set `API_BIND=0.0.0.0` in
`.env` and recreate the API; that exposes it on Windows interfaces, so keep Windows Firewall active and never forward it to
the Internet. Restore the loopback binding afterwards.

## 3. Install the agent

Build with the helper (stages source in the distro's Linux filesystem and writes `agent\dist\fledge-agent-linux`):

```powershell
.\agent\build-agent-wsl.ps1 -Distro Ubuntu-24.04 -CheckDocker
```

Or enrol through the panel with the connector helper, which installs and starts a background systemd service:

```powershell
.\agent\connect-wsl.ps1 -ApiUrl 'http://localhost:4000' -NodeId '<node-uuid>' -Repository 'kavaliersdelikt/fledge' -AllowInsecureHttp
```

Use the API URL that works from the distro. Check the service with
`wsl -d Ubuntu-24.04 -u root -- systemctl status fledge-agent`. Add `-Foreground` to tie the agent to the terminal.

To run it in the foreground by hand:

```sh
sudo env API_URL='http://localhost:4000' NODE_ID='<node-uuid>' ENROLLMENT_TOKEN='<one-time-token>' \
  DATA_ROOT='/var/lib/fledge/servers' CREDENTIAL_FILE='/var/lib/fledge/agent.credential' \
  ALLOW_INSECURE_HTTP='true' /usr/local/bin/fledge-agent
```

## 4. Verify

Check the node is connected with plausible free disk and resources, create a disposable Minecraft server, and test logs,
file operations, restart, deletion and (if you use backups) a real backup and restore.

## Caveats

- Keep `DATA_ROOT` in the distro's Linux filesystem, not under `/mnt/c`.
- `/proc` and disk readings reflect the WSL virtual disk and its limits, not the whole Windows host.
- Docker Desktop publishes game ports on the Windows host; reachability from the LAN or Internet depends on Docker Desktop,
  WSL networking, Windows Firewall and your router. Do not expose game ports until independently tested.
- If only a normal WSL user can reach Docker, a root-less agent with a data root in your home is possible for a disposable
  test, but file ownership issues may follow. Never make the Docker socket world-writable.
