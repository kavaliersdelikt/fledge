---
title: Disk limits and volumes
---

# Disk limits and volumes

Each server's data lives in a **sparse ext4 image** at `DATA_ROOT/.volumes/<id>.img`, sized to its disk allowance and
loop-mounted at `DATA_ROOT/<id>`. Because the filesystem itself is that size, the kernel returns *no space left* to the
game, SFTP and the panel alike.

## Requirements

Root, `/dev/loop-control`, and the tools `mkfs.ext4`, `losetup`, `mount`, `resize2fs`, `e2fsck`, plus `fsfreeze` and `cp`
for snapshot backups. The enforcement mode (**auto**, **require**, **off**) comes from the panel
(**Settings → Game nodes → Disk limits**):

| Mode | Behaviour |
| --- | --- |
| auto | Use volumes when the node can; otherwise fall back to soft limits |
| require | Refuse to run servers on nodes that cannot enforce limits |
| off | Never use volumes |

## Growing and shrinking

- **Growing** is applied live where the kernel allows it.
- **Shrinking**, or growing on hosts that refuse online resizing, briefly stops the server: it is stopped, the volume is
  checked and resized with `e2fsck` and `resize2fs`, and the server starts again.
- The panel refuses to shrink below the space in use.
- Usable space is about 2 % less than the allowance because of filesystem metadata.
- The unmount before a resize is *strict*: it retries while something (a stopping container) still holds the mount, waits
  until the loop device is released, and never falls back to a lazy unmount that would report success while the
  filesystem is still mounted.

## Existing servers

Servers created before volumes existed move into a volume the next time they are restarted.

## Snapshot backups

On volume nodes a running server is backed up from a frozen point-in-time copy of its volume while it keeps running
(Minecraft first flushes and pauses world saving). The result is crash-consistent. On other nodes the game is stopped
cleanly.

## What is not limited

The container's writable layer (anything a game writes outside the data mount) is not limited. Volumes need a Linux node
with root.

## Troubleshooting

- *"e2fsck: ... is mounted"* in an old agent's logs: fixed in 0.6.1.1 by the strict unmount.
- A full host disk can hang the Docker engine; see [Troubleshooting](/operate/troubleshooting#the-host-disk-is-full-and-docker-hangs).
