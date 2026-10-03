---
title: Agent protocol
---

# Agent protocol

This page is for people debugging an agent or writing their own. The reference implementation is `agent/` (Go).

## Authentication

| Step | Request |
| --- | --- |
| Enrol (once) | `POST /api/agent/enroll` `{ nodeId, token }` with the one-time token (valid ten minutes) returns `{ nodeId, credential }`. The credential is shown once |
| Everything else | `Authorization: Bearer <credential>` and `X-Node-ID: <uuid>` |

Creating a new enrollment token revokes the previous credential immediately.

## Heartbeat

`POST /api/agent/heartbeat` about every 10 seconds with the agent `version`, node `usage` (CPU, memory, disk), and the state
of each server it holds (`id`, `status`: `running`, `stopped`, `failed`, `missing`, `provisioning`, usage samples, disk bytes
and, for stopped or failed containers, an `exit` block with `code`, `oomKilled`, `finishedAt` and a log tail). A node is
*disconnected* after 35 seconds without one.

The reply carries configuration the panel pushes to every agent (allowed image prefixes, SFTP port, disk enforcement mode,
failover fencing) and instructions such as the update to perform.

## Jobs

| Request | Purpose |
| --- | --- |
| `GET /api/agent/jobs` | Lease the next job for this node (or `{job:null}`). Jobs for one server are handed out strictly in order, one at a time |
| `POST /api/agent/jobs/:id/renew` `{ attempt }` | Extend the 2-minute lease for long jobs |
| `POST /api/agent/jobs/:id/result` `{ attempt, success, result?, error? }` | Report the outcome |

A job has `id`, `kind`, `payload`, an `attempt` counter and, for server jobs, a `server` description (image, startup,
ports, env, limits). A job is retried up to five times after a lease expires; the `attempt` must match on `renew` and `result`
(`409` means the lease was lost, so stop work). Kinds are listed in [Agent job kinds](/reference/jobs).

Agents keep receipts of finished destructive jobs so a replayed job after a network failure is idempotent.

## Transfers

Backup, restore and file transfers use URLs the panel gives in the job payload:

- `GET`/`PUT /api/agent/jobs/:id/backup-object?attempt=` stream backup archives through the API when there is no presigned
  object-storage URL,
- `/api/agent/transfers/:transferId?attempt=` serve uploads and downloads of single files.

## Console stream

An outbound WebSocket to `/api/agent/stream` (see [Live console WebSocket](/api/websocket)) carries logs and samples for
servers someone is watching.

## Compatibility

The panel and agents are versioned separately; add-ons need agent 0.6.1.1 or newer, and agents older than 0.5.1.1 cannot update
themselves. Unknown job kinds should be failed with a clear error rather than ignored.
