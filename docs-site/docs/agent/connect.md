---
title: Connect a node
---

# Connect a node

## 1. Prepare the host

The host needs a supported Linux system with **systemd**, **Docker Engine** and the Docker CLI. Follow Docker's
[installation guide](https://docs.docker.com/engine/install/) for your distribution and verify:

```sh
sudo docker version    # must show both Client and Server
```

## 2. Register the node in the panel

**Nodes → Add node**: name, location, capacity and headroom. See [Nodes](/panel/nodes).

## 3. Run the connector

**Connect a node** shows a command for the host and, separately, the short-lived enrollment token. The connector:

1. downloads the Linux agent (`amd64` or `arm64`) from the matching GitHub release,
2. checks it against that release's `SHA256SUMS`,
3. asks for the token in a **hidden prompt** (so it never lands in shell history, arguments or the service
   environment),
4. exchanges it for the node credential and stores it in a mode-0600 file,
5. installs `/usr/local/bin/fledge-agent` and the `fledge-agent` systemd service.

A published `v*` release with both assets is required, and the repository must be public (or the node needs another
authenticated distribution path) for the one-line command to download.

The node should turn **connected** within seconds. If it does not, see
[Troubleshooting](/operate/troubleshooting#a-node-shows-as-disconnected).

## Manual configuration

You can also run the agent yourself with the environment from [Overview](/agent/#configuration). Create the node and its
token through the panel (or `POST /api/nodes` and `POST /api/nodes/:id/enrollment`), then run `fledge-agent` once so it
exchanges the token. Later restarts read `CREDENTIAL_FILE`; keep the one-time token out of the service configuration.

To re-enrol: create a fresh token (this revokes the old credential immediately), delete the old credential file on the
node, provide the new token and restart.

## HTTPS

Use HTTPS with a valid certificate. `ALLOW_INSECURE_HTTP=true` permits HTTP **only** for local development. The object
storage endpoint must also be reachable from the node, since the agent uploads and downloads with signed URLs.

## Building from source

```sh
cd agent
go build -o fledge-agent .
```

Plain `go build` on Windows targets Windows and fails with undefined `syscall.Stat_t`, `syscall.Openat` and similar;
that is expected: the agent targets Linux. Build inside Linux or with the [WSL helper](/agent/wsl2).

## Updating and removing

Agents [update themselves](/agent/updates). To remove a node: remove its servers (or [move them](/operate/failover)),
**Remove** the node in the panel, then `sudo systemctl disable --now fledge-agent` and delete the binary and
`/var/lib/fledge`.
