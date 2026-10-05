---
title: Virtual machine security
---

# VM isolation and consoles

Fledge generates validated libvirt XML from approved hardware, media and network policies. Customers cannot submit XML, host paths, QEMU arguments or shell commands. Media downloads require HTTPS, fixed size and SHA-256, reject private destinations and redirects, and refuse external qcow2 backing/data files before image inspection. Optional provisioning passwords are encrypted in the database and hashed in the temporary cloud-init seed; plaintext seed files are removed after ISO generation. ISO media must contain ISO9660 or UDF descriptors.

Each guest has fixed disk identities, a host-assigned MAC and a transactionally allocated address. Native nftables ingress filters and isolated bridge ports prevent MAC/IP spoofing and direct guest-to-guest bridge access. Per-guest nftables rules restrict host access and protect the configured subnet; administrator firewalls and upstream routing remain part of deployment security.

Browser consoles require a session cookie, console permission, matching Origin and a 30-second single-use ticket. Tickets are bound to the session and workload. Active sessions expire after one hour and committed authorization changes revoke relays through PostgreSQL notifications, with a one-second fallback check for account holds, suspension, permission removal and node ownership changes. Frames and queued output are bounded; slow clients disconnect. Console bytes are never stored in PostgreSQL or ordinary console history.

Keep `console`, `manage` and VM configuration grants limited to people allowed to control the operating system. Console access can expose anything on the guest's screen. Full backups and snapshots include guest secrets, firmware and TPM state; protect their object storage and retention accordingly.

Granular collaborator grants are `vm.configure`, `vm.network`, `vm.media` and `vm.snapshots`. They default off. Existing `manage` remains comprehensive. Administrator equivalents are `servers.vm.configure`, `servers.vm.network`, `servers.vm.media` and `servers.vm.snapshots`; existing view, console, power and backup grants continue to apply.
