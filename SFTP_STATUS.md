# SFTP implementation and local status

The agent now includes an SSH/SFTP subsystem. It accepts password authentication only for short-lived per-server credentials issued by the panel. Each connection checks authorization with the control plane, allows SFTP file and directory operations within that server data root, rejects symlinks and unsupported SSH shell/forwarding channels, and expires after 15 minutes. The UI hides credentials after display; rotate by requesting a new SFTP session.

On an agent, set `SFTP_LISTEN` to a restricted SSH bind address such as `127.0.0.1:2022` for a local evaluation. `SFTP_HOST_KEY` optionally selects a persistent private host-key file; otherwise it is created beside the agent credential file with mode 0600. Publish or firewall the SSH port yourself for remote clients. Never bind publicly without TLS/network policy and rate protection appropriate to your environment. The Go tests exercise SSH authentication, subsystem negotiation, upload/download, symlink confinement and write allowances.

Disk checks are logical write guards, not kernel/filesystem quotas, and game processes can exceed server allowances. Dedicated Linux host, revocation under load, public port forwarding, and customer-facing SFTP clients have not been tested.
