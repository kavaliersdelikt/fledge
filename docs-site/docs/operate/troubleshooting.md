---
title: Troubleshooting
---

# Troubleshooting

## The panel says it cannot reach the API

`NEXT_PUBLIC_API_URL` must be a browser-reachable address and `WEB_ORIGIN` must equal the origin in your address bar.
Behind a proxy see [Reverse proxy and TLS](/operate/reverse-proxy). After changing `NEXT_PUBLIC_API_URL`, rebuild with
`docker compose up --build -d`.

## I am locked out of the administrator account

- Lost authenticator: use a saved **recovery code** on the sign-in page. Recovery codes are one-time and reset the
  password and two-factor.
- Locked out by the **network allow-list**: set `ADMIN_IP_ALLOW_DISABLE=true` in `.env`, restart the `api`, fix the
  list under **Settings → Panel → Security**, then remove the variable.
- Lost recovery codes too: there is no self-service path. Ask in the community channels before editing the database by hand.

## The panel looks wrong after changing the appearance

Use [safe mode](/operate/branding-recovery#safe-mode) (`?safe=1`) to get in, then restore an earlier version or reset. See
[Recovering from a bad theme](/operate/branding-recovery).

## A node shows as disconnected

A node is disconnected after 35 seconds without a heartbeat. Game containers keep running independently.

```sh
sudo systemctl status fledge-agent
sudo journalctl -u fledge-agent -n 100 --no-pager
curl -fsS https://panel.example.com/api/health
```

Typical causes: the panel URL is not reachable from the node, a TLS certificate problem, Docker not running, or an
expired enrollment token (tokens last ten minutes; create a new one under **Connect a node**).

## Create or start fails with "insufficient capacity" or "no free ports"

Placement considers the node's registered capacity minus headroom and the ports already allocated (20000-50000 by
default). Check **Nodes** for reserved memory per server and add capacity or another node.

## "No space left on device" inside a game

Disk limits are real: the kernel returns *no space left* when the server's allowance is full. Increase the allowance
under the server's **Resources** (growing is usually live), or free space in the file manager. The panel refuses to
shrink below current use.

## The host disk is full and Docker hangs

A full disk on the Docker host can hang the engine and kill game containers (an exit code of 135 with a bus error is
typical). Free space (`docker system prune`, old images and build cache first), then restart Docker. Consider alerts on
the node's disk (**Settings → Notifications** has a low-disk event).

## Stopping a Minecraft server fails during boot

Older agents wrote the stop command to a pipe Docker does not allow ("bad file descriptor") and RCON only answers once
the world has loaded. With agent **0.6.1.1 or newer** the stop is queued on the console pipe and the server finishes
starting, saves and exits cleanly. Update the agent and recreate the container once (a resource change or **Update
servers** does that) so it has the pipe. See [Console and stopping](/agent/console).

## A plugin or add-on does not work

- **Plugins → (plugin) → Logs** shows errors; **Test connection** checks the catalog.
- A plugin that fails five times in a row is switched off automatically (the reason is shown); catalog slowness is
  not counted.
- The Mods/Plugins tab explains when a node's agent is too old or when the template does not support add-ons.
- Add-ons only take effect after a server restart.

## Email is not arriving

Use **Send test email** (save first). Check the SMTP security mode matches the port (587 *STARTTLS*, 465 *TLS*). Look at
`docker compose logs api` for the SMTP error.

## Backups fail with 503

Object storage is not configured or not reachable. See [Backups and object storage](/operate/backups).

## Get help

Include the panel version, the relevant log lines and what you expected, and **redact credentials, enrollment tokens
and backup URLs**. Ask in the [Discord](https://discord.gg/gu49ZF6tQh) or open an
[issue](https://github.com/kavaliersdelikt/fledge/issues/new).
