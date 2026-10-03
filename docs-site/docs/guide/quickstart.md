---
title: Quickstart
---

# Quickstart

About ten minutes from nothing to a running game server. You need one machine with Docker for the panel, and one
Linux machine with Docker for the game node (they can be the same machine for a trial).

## 1. Install the panel

::: code-group

```sh [Linux / macOS]
git clone --depth 1 --branch main https://github.com/kavaliersdelikt/fledge.git fledge && cd fledge && sh ./install.sh
```

```powershell [Windows PowerShell]
git clone --depth 1 --branch main https://github.com/kavaliersdelikt/fledge.git fledge; Set-Location fledge; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

:::

The installer keeps an existing `.env`, generates private secrets for a new one, starts Docker Compose and waits for
the health checks. Open <http://localhost:3000>.

See [Install](/operate/install) for the details and the manual route.

## 2. Create the administrator

The first visit creates the administrator account and asks you to enrol an authenticator app. Save the recovery
codes it shows; they are the only way back in if you lose the device.

![First sign-in and two-factor setup](/screenshots/first-run.webp){.screenshot}

## 3. Add a node

1. Open **Nodes** and register the node: a name, a location label and its capacity (memory, CPU, disk).
2. Choose **Connect a node** to get a one-time command (valid for ten minutes) and run it on the Linux host.
   The host needs Docker Engine and systemd already installed. See [Connect a node](/agent/connect).
3. The node turns *connected* within seconds.

![The Nodes page](/screenshots/nodes.webp){.screenshot}

## 4. Create a customer and a server

1. **Customers → New customer**. Fledge shows a temporary password once (or emails an invitation if
   [email](/operate/email) is configured).
2. **Servers → New server**: pick the customer, a template (for example Minecraft Paper), and resources.
3. The server is placed on a node with room and started. Watch it in the live console.

![A server's console](/screenshots/server-console.webp){.screenshot}

## Next steps

- Turn on [backups](/operate/backups) (object storage) so you can restore and use failover.
- Put the panel behind [TLS](/operate/reverse-proxy) before exposing it.
- Install the [Modrinth plugins](/plugins/using) to add mods and plugins from the server page.
- Add [schedules](/panel/schedules) and [crash protection](/panel/crash-protection).
