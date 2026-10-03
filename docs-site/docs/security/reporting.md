---
title: Reporting a vulnerability
---

# Reporting a vulnerability

## Supported versions

Fledge is actively developed and is currently intended for evaluation and controlled testing. It has not completed a
production security review, and no production support or response-time guarantee is offered.

Only the latest stable release is considered for security fixes. Older releases, prereleases, development builds and forks may not
receive fixes.

## Report privately

Please report suspected security vulnerabilities **privately**. Do not publish exploit details in a public issue, discussion, pull
request or chat.

Use [GitHub's private vulnerability reporting form](https://github.com/kavaliersdelikt/fledge/security/advisories/new). Include:

- the affected Fledge version, commit or component,
- the deployment and configuration needed to reproduce the issue, with secrets and personal data removed,
- clear reproduction steps and the security impact you observed,
- any known workaround or suggested mitigation.

Do not include real credentials, tokens, customer data or other secrets. If any secret may have been exposed, revoke or rotate it
immediately and describe the exposure without repeating the secret.

## Coordination

Maintainers review reports privately and coordinate remediation and public disclosure with the reporter where practical. Please allow
time for a fix and user guidance to be prepared before publishing details. No fixed response or remediation deadline is guaranteed.

## Scope

Welcome: issues in the panel, API, node agent, installers, update system and repository-maintained deployment configuration. Also in scope:
the plugin host, the sandbox, plugin package and registry handling, and the add-on installation path. Issues caused solely by unsupported
third-party software or host misconfiguration may be out of scope, but can still be reported if they expose a Fledge-specific weakness.
