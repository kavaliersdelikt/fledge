---
title: Console and stopping
---

# Console and stopping

New game containers keep standard input open. The console streams Docker logs and resource samples and sends one line to
the container per command.

## Minecraft

Minecraft containers are preset to use authenticated **RCON**. Commands go through `rcon-cli` against `127.0.0.1` (IPv4 is
forced because on Alpine images `localhost` may resolve to `::1` while the RCON listener is bound to `0.0.0.0`).

RCON only answers once the world has loaded. While the server is still **starting**:

- a command is queued on the **console pipe** and runs as soon as the console is up (the panel tells you it was queued),
- a **stop** is queued the same way: the server finishes starting, saves and exits cleanly with code 0, instead of being
  killed after a timeout.

Containers are created with `CREATE_CONSOLE_IN_PIPE=TRUE`, which makes the image create a named pipe at
`/tmp/minecraft-console-in`. The agent writes to it as the **game user** (the owner of `/data`) with
`docker exec --user <uid> <container> mc-send-to-console <line>`. Containers created before agent 0.6.1.1 do not have the
pipe until they are recreated (a resource or variable change, **Update servers**, or a failover does that).

### Stopping

A graceful stop sends RCON `stop` and waits for the container to exit. If RCON is not ready and the pipe exists, the stop is
queued on the pipe and the agent waits up to **3 minutes** through the boot. In every other case, or if the wait runs
out, it falls back to `docker stop -t <seconds>` (SIGTERM, then SIGKILL).

During the very first minutes of a brand-new container (downloads, before the pipe exists) the agent skips the pipe,
since nothing would read it, and uses `docker stop`.

The wait is bounded because an agent handles one job at a time.

## Other games

Other console input is sent over one persistent Docker attachment to container stdin. The game must read stdin for lines
to have an effect.

## Why not the image's own fallback?

The itzg image's stop helper falls back to writing `/dev/stdin`, which cannot work with Docker's read-only stdin pipe
("write /dev/stdin: bad file descriptor") and ends in SIGKILL; the pipe approach avoids it.
