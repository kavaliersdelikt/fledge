---
title: Resources and disk limits
---

# Resources and disk limits

**Settings → Resources** on a server shows memory, CPU and disk. Administrators can change them; customers see them.

| Resource | Meaning |
| --- | --- |
| Memory (MB) | Container memory limit; also counted against the node's reserved capacity |
| CPU (%) | 100 = one CPU core |
| Disk (MB) | The size of the server's data volume |

- Raising memory or CPU applies live where possible.
- **Disk** is enforced by the kernel: each server's data lives in a sparse ext4 image sized to its allowance, so the
  game, SFTP and the panel all get *no space left*. Growing is applied live where the kernel allows it; shrinking (or
  growing on hosts that refuse online resizing) briefly stops the server. The panel refuses to shrink below current use.
  See [Disk limits and volumes](/agent/disk-limits).
- A node's capacity is the sum its servers may reserve. Changing a server's resources fails with *Insufficient reserved
  capacity* when the node cannot take it.
- A customer with a [quota](/panel/customers) cannot go above it; administrators can override deliberately (a *force*
  option on the request).

Usage numbers come from the node's heartbeat samples. The graphs under [Usage history](/panel/usage-history) keep the
last days.
