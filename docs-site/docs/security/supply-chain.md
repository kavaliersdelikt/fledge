---
title: Verifying releases
---

# Verifying releases

A Fledge release is created by the GitHub Actions workflow *Release Linux node agent* when a `v*` tag is pushed. It publishes:

| Asset | Content |
| --- | --- |
| `fledge-agent_linux_amd64`, `fledge-agent_linux_arm64` | The node agent binaries (static, built with `-trimpath`) |
| `SHA256SUMS`, `VERSION` | Checksums and the version |
| `SHA256SUMS.sig`, `SHA256SUMS.pem` | A keyless **cosign** signature and certificate for `SHA256SUMS` (best effort; present when signing worked) |
| `<id>-<version>.fledgeplugin` and `SHA256SUMS.plugins` | The bundled plugins as packages (signed with the release signing key when configured) |
| `sbom-api.cdx.json`, `sbom-web.cdx.json`, `sbom-host.cdx.json`, `sbom-agent.cdx.json` | CycloneDX **software bills of materials** |
| Build provenance attestations | For the agent binaries and plugin packages |

## Verify an agent binary

```sh
curl -fsSLO https://github.com/kavaliersdelikt/fledge/releases/download/v0.7.1.1/fledge-agent_linux_amd64
curl -fsSLO https://github.com/kavaliersdelikt/fledge/releases/download/v0.7.1.1/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

The one-line connector and the panel's agent updater do the checksum comparison for you and refuse a mismatch.

### Signature

```sh
curl -fsSLO https://github.com/kavaliersdelikt/fledge/releases/download/v0.7.1.1/SHA256SUMS.sig
curl -fsSLO https://github.com/kavaliersdelikt/fledge/releases/download/v0.7.1.1/SHA256SUMS.pem
cosign verify-blob SHA256SUMS --signature SHA256SUMS.sig --certificate SHA256SUMS.pem \
  --certificate-identity-regexp 'https://github.com/kavaliersdelikt/fledge/.github/workflows/release-agent.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### Provenance

```sh
gh attestation verify fledge-agent_linux_amd64 --repo kavaliersdelikt/fledge
```

## Plugin packages and the registry

Registry entries are signed with an Ed25519 key. The panel verifies the package SHA-256 against the index, then the signature
against the keys **you** added under **Plugins → Settings → Trusted keys**; it ships with no built-in key. You can verify a
package yourself:

```sh
node plugins/tools/pack.mjs verify my-plugin-1.0.0.fledgeplugin --key <base64-spki-public-key> --signature <base64-signature>
```

## SBOMs

The SBOM jobs run in a workflow job that has no signing or publishing permissions, then upload their output as an artifact that
the release job attaches. Feed them to your vulnerability scanner of choice.

## Dependencies

The repository uses Dependabot and GitHub code scanning; both are checked before a release. `npm audit` is clean for the API, panel,
plugin host and plugin tools at release time.
