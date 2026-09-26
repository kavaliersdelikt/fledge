# Security Policy

## Supported versions

Fledge is actively developed and is currently intended for evaluation and controlled testing. It has not completed a production security review, and no production support or response-time guarantee is offered.

Only the latest stable release is currently considered for security fixes. Older releases, prereleases, development builds, and forks may not receive fixes.

## Report a vulnerability

Please report suspected security vulnerabilities privately. Do not publish exploit details in a public issue, discussion, pull request, or chat.

Use [GitHub's private vulnerability reporting form](https://github.com/kavaliersdelikt/fledge/security/advisories/new).
Include:

- The affected Fledge version, commit, or component.
- The deployment and configuration needed to reproduce the issue, with secrets and personal data removed.
- Clear reproduction steps and the security impact you observed.
- Any known workaround or suggested mitigation.

Do not include real credentials, tokens, customer data, or other secrets in a report. If any secret may have been exposed, revoke or rotate it immediately and describe the exposure without repeating the secret.

## Coordination

The maintainers will review reports privately and coordinate remediation and public disclosure with the reporter where practical. Please allow time for a fix and user guidance to be prepared before publishing details. No fixed response or remediation deadline is guaranteed.

## Scope

Reports are welcome for security issues in Fledge's panel, API, node agent, installers, update system, and repository-maintained deployment configuration. Issues caused solely by unsupported third-party software or a host misconfiguration may be outside Fledge's control, but can still be reported if they expose a Fledge-specific weakness.
