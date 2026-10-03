---
title: Monitoring
---

# Monitoring

## Health endpoints

| Endpoint | Meaning |
| --- | --- |
| `GET /api/health` | Unauthenticated; `{"ok":true}` when the API is up |
| Plugin host `GET /health` | Unauthenticated, reachable only on the internal network: `{ok, version, sandbox}` |

Docker Compose runs a health check on the plugin host; `docker compose ps` shows it.

## Prometheus

`GET /api/metrics` returns Prometheus text. It is **administrator only** and, today, only an administrator
*session* can read it: API tokens cannot reach it. That makes unattended scraping awkward (a scraper has to hold an
administrator session cookie). Until a dedicated metrics token exists, either scrape from a trusted small script that
reuses a long-lived administrator session, or use the notifications and the Resilience page for alerting. The metrics:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `fledge_nodes` | `status` | Registered nodes by connection state |
| `fledge_servers` | `status` | Servers by observed state |
| `fledge_jobs` | `state` | Jobs by state |
| `fledge_failover_events` | `state` | Failover events by state |
| `fledge_servers_without_backup` | | Servers that have no successful backup |
| `fledge_servers_crash_looping` | | Servers whose automatic restarts were stopped |
| `fledge_notification_channels_failing` | | Channels whose last delivery failed |
| `fledge_schedule_runs` | `state` | Schedule runs in the last 24 hours |
| `fledge_plugins` | `enabled` | Installed plugins |
| `fledge_server_addons` | `state` | Tracked add-ons |
| `fledge_sessions`, `fledge_passkeys` | | Active sessions and registered passkeys |

Example alert rules:

```yaml
- alert: FledgeNodeDown
  expr: fledge_nodes{status="disconnected"} > 0
  for: 5m
- alert: FledgeServersWithoutBackup
  expr: fledge_servers_without_backup > 0
  for: 1d
- alert: FledgeCrashLoop
  expr: fledge_servers_crash_looping > 0
```

## History in the panel

Each server's **Usage** tab keeps CPU and memory history (1 hour to 30 days; see [Usage history](/panel/usage-history)).

## Notifications

Instead of polling, let Fledge tell you: [Notifications](/panel/notifications) cover node offline/online, crashes,
crash loops, low disk, failed backups, failover, failed schedules and plugin problems.

## Logs

```sh
docker compose logs -f api web plugins
docker compose logs --since 10m api
```

API logs are JSON lines. On a node: `journalctl -u fledge-agent -f`. A plugin's own log lines appear in
**Plugins → (plugin) → Logs**.
