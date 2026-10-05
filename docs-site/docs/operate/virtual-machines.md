---
title: VM node setup
---

# VM node setup

VM hosting is disabled by default. Use a dedicated Linux x86-64 host with usable `/dev/kvm`, libvirt system domains and local qcow2 storage. The agent needs permission to manage libvirt, nftables, media storage and QEMU ACLs; the normal Docker agent privileges alone do not establish these prerequisites.

Install libvirt/QEMU, `qemu-img`, `genisoimage`, `nft`, `setfacl`, `ip` and `bridge` from iproute2. Install OVMF for UEFI and `swtpm` and `swtpm-tools` (including `swtpm_setup`) for TPM. TPM state directories require libvirt **10.10 or later**. Keep libvirt's AppArmor/SELinux confinement enabled and allow only the configured Fledge data paths through the distribution's policy.

```ini
VM_QEMU_USER=libvirt-qemu
VM_TPM_USER=tss
VM_UEFI_CODE=/usr/share/OVMF/OVMF_CODE_4M.fd
VM_UEFI_SECURE_CODE=/usr/share/OVMF/OVMF_CODE_4M.ms.fd
VM_UEFI_VARS=/usr/share/OVMF/OVMF_VARS_4M.fd
VM_UEFI_SECURE_VARS=/usr/share/OVMF/OVMF_VARS_4M.ms.fd
```

The QEMU account differs by distribution. All ancestors of `DATA_ROOT` must permit QEMU traversal. Fledge grants access to a workload's managed disks and seed, without granting tenant access to the host filesystem. Use a local filesystem supporting atomic directory exchange for restore.

## Networks

Create and start the network through the host's libvirt configuration first, then register its **existing name**, eligible nodes, gateway, prefix, DNS and guest address pool in Fledge. Follow libvirt's [network format](https://libvirt.org/formatnetwork.html). Never include gateways, host management addresses or infrastructure addresses in the guest pool. Use one coordinated pool across nodes only when upstream routing supports that placement.

For NAT, enable forwarding and libvirt's NAT rules. Fledge adds per-VM nftables rules for isolation and allocated port DNAT; the host's firewall must also permit the intended forwarded connections. No Fledge rule overrides an administrator's firewall drop. Verify reachability from outside the host before offering a plan.

For routed IPv4/IPv6, arrange provider routes, return paths and forwarding before enabling the pool. Guest bridge ports are isolated and native nftables ingress filters enforce approved MAC/IP identities. Host service access is restricted; guest firewall rules still govern public services. The panel cannot install an upstream route at your provider.

Discovery reports KVM, architecture, libvirt, firmware, TPM, required tools and active network names. In **Virtual machines > Nodes**, wait for the node to connect and pass its checks, then switch on **Allow new VMs on this node**. The switch is disabled until the Linux agent reports KVM, libvirt and network isolation ready. This panel allow-list is the explicit opt-in; disabling it prevents new placements and migrations without stopping existing guests. An unavailable capability prevents placement before reservations are taken. No `VM_ENABLED` environment flag is required.

## Console relay

Agents open authenticated outbound WebSockets to the API. VNC and serial listen only on local Unix sockets. Proxy WebSocket upgrades for `/api/vm-console/` and `/api/agent/vm-console/`; do not expose a QEMU VNC TCP port.

One API instance needs no Redis. For replicas, configure a shared `VM_REDIS_URL` and set `API_REPLICAS` to the number of instances. Redis transports bounded binary frames through pub/sub; it is not console history. Protect Redis with authentication, TLS where appropriate and a dedicated network.

## Before enabling a plan

Boot a disposable guest on the actual node. Verify desktop and serial connections, external and guest networking, disk persistence, graceful shutdown, restart, stopped snapshots and full backup/restore. Verify Secure Boot and TPM with the exact Windows/UEFI profile you intend to offer. A software-emulated development guest does not verify KVM or provider routing.

The native `netdev` ingress hook and Linux bridge port isolation must be available. Fledge creates persistent tap devices on the approved bridge and installs identity filters before allowing a guest to start. It does not depend on ebtables. Discovery probes ingress filtering; failures keep VM placement disabled.

The agent grants the configured QEMU and TPM service accounts ACLs on owned guest storage. Match `VM_TPM_USER` to an existing account in the host's libvirt swtpm configuration. Discovery rejects TPM profiles when the helper or account is missing. Keep AppArmor/SELinux enabled and permit only managed storage paths through the host policy. Restart reconciliation reinstalls owned tap filters and fences guests whose authorization, manifest or firewall cannot be recovered.

Guest egress to private infrastructure ranges and host services is blocked, apart from the configured gateway DNS and required neighbor discovery. Routed IPv6 guests must use the approved MAC-derived EUI-64 link-local address; configure this in manually installed guests. Verify provider routing and the guest's IPv6 configuration together before enabling such a pool.

![Administrator catalogue for approved VM hardware, media and networks](/screenshots/vm-catalogue.webp){.screenshot}

Secure Boot profiles require a separate variable template with trusted keys already enrolled. Fledge requests both Secure Boot and enrolled keys through libvirt; the ordinary empty OVMF variable store is insufficient. Use a signed guest installer trusted by those keys. See [libvirt firmware features](https://libvirt.org/formatdomain.html#bios-bootloader).
