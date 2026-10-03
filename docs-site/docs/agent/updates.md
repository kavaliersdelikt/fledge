---
title: Agent updates
---

# Agent updates

Nodes report their agent version. When a newer release exists (a GitHub release of your configured repository, or your own
download URL), **Nodes** shows **Update to x.y.z.w**; **Update N agents** updates all, and **Update node agents
automatically** (Settings → Updates) does it unattended.

## How an update works

1. The panel queues an `agent.update` job with the download URL and the expected SHA-256.
2. The agent downloads the binary and verifies the checksum.
3. It runs the new binary once to confirm its version (`--version`).
4. It keeps the old binary as `fledge-agent.prev`, swaps the binary and re-executes itself in place.
5. It confirms the new version to the panel.

A new version that fails to start three times is rolled back and **not retried** (a marker file
`agent-update-failed-<version>` records it, and a failed update raises an `agent.update_failed`
[notification](/panel/notifications)).

Agents older than **0.5.1.1** cannot update themselves; reconnect them once with the [connector](/agent/connect).

## Your own distribution point

Instead of GitHub, set an update source URL under **Settings → Updates**. It must serve `VERSION`, `SHA256SUMS` and
`fledge-agent_linux_amd64` / `fledge-agent_linux_arm64`.

## Versions

Add-ons need agent **0.6.1.1 or newer**; the plugin tabs say when a node is too old. Check a node's version in **Nodes** or with
`fledge-agent --version`.
