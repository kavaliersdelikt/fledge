---
title: Failover and moves
---

# Failover and server moves

Everything is managed in **Settings → Panel → Automatic failover** and watched on the **Resilience** page. Failover is
**off** until you turn it on, and it needs [object storage](/operate/backups) because servers are rebuilt from
backups.

## Automatic failover

When a node has been silent for the configured wait (default 5 minutes), each of its servers is re-homed on a
connected node with room (same location first; you can restrict it to that location), created there and restored
from its newest backup. Up to *N* recoveries run at once.

- Servers whose newest backup is too old, or that have none, are **not** moved. They appear as *Waiting* with the
  reason, and the webhook is told, unless you allow recovery with empty data.
- **Data written since the last backup is lost.** The page shows each server's backup age. *Keep backups fresh* can
  take backups on a schedule (only on nodes with disk volumes, where it does not stop the game).
- Extra ports move with the server.
- A per-server switch turns failover off for servers you would rather recover by hand.

## No double running

When the old node returns it is told to remove its copy of every server that now lives elsewhere (moved aside and kept
for a few days by default). Optionally, **Stop servers if a node loses the panel** makes nodes stop their protected
servers after most of the waiting time without contact, so a node that is cut off but still alive cannot run a server
that has already been started elsewhere. Without it, a partitioned node keeps its game running until it reconnects.

## Planned moves

On the **Resilience** page, **Move** on a server (or **Empty node** on a node) stops the server, takes a final backup, rebuilds it on another
node and only then removes the old copy. Nothing is lost; expect a few minutes of downtime.

## Simulate failure

For a node, shows where each server would go and which would stay down, without changing anything.

## Monitoring

The Resilience page shows readiness per server, node state with a failover countdown, recovery history with timings
and node up/down history. [Metrics](/operate/monitoring) include `fledge_failover_events{state}` and
`fledge_servers_without_backup`. An optional webhook (Slack, Discord, Mattermost compatible) is told when a node goes
offline or returns and when a server is recovered, blocked or fails. Notification channels (see
[Notifications](/panel/notifications)) also announce these events.

## Limits

Failover is backup-based, not replication. It does not detect a hung game on a healthy node, a node that is reachable
but broken, or an outage of the panel itself. A failed recovery leaves the server on the new node in a failed state
with the old data kept aside, to be retried by hand. Live migration without downtime is not implemented.
