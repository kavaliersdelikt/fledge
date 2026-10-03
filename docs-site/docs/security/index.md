---
title: Security overview
---

# Security overview and threat model

::: warning Status
Fledge has not completed a production security review. The controls below reduce risk; they are not a substitute for one.
Rootless operation, load testing, external monitoring and credential-rotation operations remain unvalidated.
:::

## What you are trusting

| Component | Trust | Why it matters |
| --- | --- | --- |
| **Administrators** | Full | They can run code on every node through templates and images |
| **Node agent** | High (root-equivalent) | It controls Docker and server files; install it only on hosts you administer |
| **Updater service** | High | Has the Docker socket and the checkout; not published to the host |
| **API** | High | Holds the database and `ENCRYPTION_KEY` |
| **Plugin host** | Low | Runs untrusted code in a sandbox with no secrets, no database and no published port |
| **Customers** | Low | Own servers; limited by permissions, quotas and the allowed-image list |
| **Plugins** | Low | Sandboxed, permission-gated, every answer validated |

## Boundaries and what protects them

| Boundary | Controls |
| --- | --- |
| Browser to API | `HttpOnly` `SameSite=Strict` session cookie (Secure in production), Origin checks, CSP and frame headers, rate limits shared across replicas, mandatory two-factor for administrators, passkeys, per-account second-factor throttling, optional admin IP allow-list |
| API tokens | Scopes (`read`, `provision`, `suspend`), a fixed endpoint allow-list, shown once, revoked on password reset, subject to the IP allow-list |
| API to node | The node only connects outward; its credential is a high-entropy secret stored hashed; jobs are leased, attempt-fenced and idempotent; path confinement on all file operations |
| Node to game | Docker memory, CPU and PID limits, `no-new-privileges`, kernel-enforced disk limits, an image allow-list |
| API to plugins | Separate container (read-only root, no capabilities, own network), bearer token, WebAssembly sandbox, declared network hosts, public-address-only egress, validated results, node-side checksum verification of add-on files |
| Appearance | Only administrators with a browser session can change it (not API tokens), every change is audited and versioned; uploaded images are checked by their contents and served sandboxed; custom CSS is off by default and cannot load anything from another server; safe mode and `BRANDING_DISABLED` recover from a bad theme. See [Appearance](/panel/appearance#advanced) |
| Secrets at rest | AES-256-GCM with `ENCRYPTION_KEY` for two-factor secrets, S3 and SMTP credentials, webhook URLs and plugin secrets |
| Supply chain | Release checksums, optional signatures and attestations, SBOMs, signed plugin registry; see [Verifying releases](/security/supply-chain) |

## Specific design choices

- **Outbound-only agents.** Nothing on the node listens for the panel; compromising the network path to a node does not let
  anyone give it orders without the credential.
- **Admin 2FA is not optional.** An administrator account cannot use the panel before enrolling an authenticator.
- **Templates are code.** A template's image and startup command run on nodes. Only administrators can create them, and images must
  match the allow-list on both API and agents.
- **Customers never see commands or template-level environment.** Secret variables are hidden from non-administrators.
- **Defensive outbound requests.** Webhooks, the plugin registry and the plugin host refuse private and link-local addresses (except
  for administrator webhooks by design), pin the connection to the checked address and re-check redirects.
- **No double running.** Failover fences old copies; see [Failover](/operate/failover).
- **Appearance is data, not code.** Names, links and announcements are plain text; colours are validated hex values from which Fledge calculates every other colour; images are identified by their bytes, plain SVGs only. The one free-form field, custom CSS, is off by default, refuses `@import`, fonts and remote `url()`, and runs under the unchanged content security policy.
- **Audit log.** Sign-ins, changes, installs and exports are recorded, with filters and export.

## What is not protected

- A compromised **administrator** or **node host** can do almost anything, by design.
- A malicious but correctly signed or approved **plugin or add-on** can still offer harmful files with matching checksums; Fledge
  does not scan jars.
- Games are the games' own attack surface. Fledge isolates them with Docker, not with VMs.
- The panel is not hardened against a hostile local user on the Docker host.
- Failover and backups are not a substitute for tested disaster recovery.

See the [Hardening checklist](/security/hardening) and the [plugin security model](/plugins/security).
