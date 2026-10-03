---
title: Releasing
---

# Releasing

Versions have four parts, `major.minor.patch.release` (for example `0.7.1.1`).

## Checklist

1. Bump the version in `api/package.json`, `web/package.json`, `plugins/host/package.json`, `plugins/tools/package.json` and their
   lock files, `agent/main.go` (`version`) and `.env.example` (`APP_VERSION`). Bundled plugin manifests carry their own versions and
   `minPanelVersion`.
2. Write the release notes in `docs/releases/vX.Y.Z.N.md`: highlights, added, changed, fixed, **verified** (what was really tested and
   what was not), known limits and upgrade steps.
3. Make sure CI is green, `npm audit` is clean in every package, and Dependabot and code-scanning alerts are resolved.
4. Tag `vX.Y.Z.N`. The workflow *Release Linux node agent* then:
   - builds the agent for `amd64` and `arm64` and writes `SHA256SUMS` and `VERSION`,
   - packages the bundled plugins (signed when `PLUGIN_SIGNING_KEY` is configured),
   - collects SBOMs from an unprivileged job,
   - signs `SHA256SUMS` with cosign and attests build provenance (best effort),
   - creates the GitHub release with all assets.
5. Update nodes: the panel offers the new agent once the release exists.

## Plugin registry

If you maintain a registry, rebuild and sign its index with `plugins/tools/pack.mjs index` after releasing new plugin versions.

## Documentation

The docs site is built and published to GitHub Pages by a workflow on pushes to `main` that touch `docs-site/`, the API, the plugin host,
the schema or the agent, and on release tags.
