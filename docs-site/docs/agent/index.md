---
title: Node agent
---

# The node agent

The agent is a **Linux** Go program that runs on every game node. It does not listen on a port: it polls the control
plane over HTTPS for durable jobs, heartbeats every 10 seconds, and opens an authenticated outbound WebSocket for
on-demand Docker logs and CPU/memory samples. It runs jobs with the local Docker CLI and keeps receipts of successful
destructive jobs in `DATA_ROOT/.jobs`, so a job can be replayed idempotently after a network loss. Its node credential
lives in a mode-0600 file.

::: warning The agent is root-equivalent
The Docker socket is root-equivalent, and the supplied systemd unit runs the agent as root so it can read and write
game files after images change bind-mount ownership. Install it only on hosts you administer, restrict network egress,
and rotate the enrollment credential if a node is compromised. A non-root or rootless setup is possible but has not been
validated.
:::

## Requirements

- Linux with **systemd**, Docker Engine and the `docker` CLI. The connector installs the agent; it does **not** install
  Docker.
- For [disk limits](/agent/disk-limits): root, loop devices and `e2fsprogs` (`mkfs.ext4`, `resize2fs`, `e2fsck`), plus
  `losetup`, `mount`, and `fsfreeze`/`cp` for snapshot backups.
- `amd64` or `arm64`.
- Outbound HTTPS to the panel (and to the object storage endpoint, for backups).

Windows and macOS are not node targets. Windows with Docker Desktop and WSL2 works for [local evaluation](/agent/wsl2).

## What it manages

Each server is a container named `nvr-<uuid>` with its data under `DATA_ROOT/<uuid>` (`/data` for Minecraft, `/config` for
Valheim). Containers get Docker memory, CPU and PID limits and `no-new-privileges`; Docker's default capabilities remain
so official images can initialize and chown their mounted data. Ports are published with Docker's `-p`.

Custom template startup commands run via `/bin/sh -c` inside the image, so the image needs a shell. Only images whose
prefix is on the **allowed images** list (configured in the panel and applied to all agents) are accepted.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_URL` | | The panel's API address (HTTPS outside local tests) |
| `NODE_ID` | | The node's UUID from the panel |
| `ENROLLMENT_TOKEN` | | One-time token; used once, then cleared from the process environment. Do not keep it in service config |
| `DATA_ROOT` | `/var/lib/fledge/servers` | Where server data lives |
| `CREDENTIAL_FILE` | `/var/lib/fledge/agent.credential` | Where the node credential is stored |
| `ALLOWED_IMAGE_PREFIXES` | built-in list | Should match the panel's list; the panel pushes its list in heartbeats |
| `ALLOW_INSECURE_HTTP` | `false` | `true` allows HTTP for local evaluation only |
| `SFTP_HOST_KEY` | beside the credential file | Path of the persistent SFTP host key |

The connector normally writes these into the systemd unit. Version: `fledge-agent --version`.

## Local state

Next to `CREDENTIAL_FILE` the agent keeps small state files: `agent-update.json` and `agent-update-failed-<version>`
([updates](/agent/updates)), `failover.json` (self-fencing state), and the SFTP host key. Back up the host key if you use
SFTP.

## Backups

A backup stages a `tar.gz` under `DATA_ROOT` and uploads it to S3 with a signed URL, so budget free disk at least the size
of the compressed archive (unless the node uses snapshot backups; see [Disk limits](/agent/disk-limits)).

## Failover support

Heartbeats list every server the node holds (`held`). The panel answers with `evict` jobs for copies of servers that now
live elsewhere; the agent removes the container and moves the data to `DATA_ROOT/.evicted/` (deleted after the configured
retention). With *Stop servers if a node loses the panel* on, the agent stops its protected servers after the configured
silence and restarts them when the panel answers again and still assigns them to this node.

## Job reference

The jobs an agent understands are listed, generated from the source, in [Agent job kinds](/reference/jobs). To write your
own agent, see the [Agent protocol](/api/agent-protocol).
