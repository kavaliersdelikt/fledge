---
title: Webhook payloads
---

# Webhook payloads

[Notification channels](/panel/notifications) of kind **webhook** POST JSON to your HTTPS endpoint. Discord and Slack
channels use their own simple formats.

## Generic webhook

```json
{
  "text": "Fledge: Survival crashed (Survival) — exit code 137, out of memory",
  "content": "Fledge: Survival crashed (Survival) — exit code 137, out of memory",
  "event": {
    "kind": "server.crashed",
    "severity": "bad",
    "title": "Survival crashed",
    "body": "exit code 137, out of memory",
    "server": { "id": "<uuid>", "name": "Survival" },
    "nodeId": null,
    "data": { "exit": { "code": 137, "oomKilled": true } },
    "at": "2026-10-03T12:00:00.000Z"
  }
}
```

- `text` and `content` hold the same line, so the payload works with **Slack-compatible** (`text`), **Discord-compatible**
  (`content`) and **Mattermost** endpoints unchanged.
- `event.kind` is one of the [notification events](/reference/events); `severity` is `ok`, `info`, `warn` or `bad`.
- `server` and `nodeId` are `null` when the event is not about a server or node. `data` is event specific.

## Discord and Slack

| Channel | Body |
| --- | --- |
| Discord | `{ "content": "<text>" }` |
| Slack | `{ "text": "<text>" }` |

Text is limited to about 1900 characters.

## Delivery

- `POST`, `Content-Type: application/json`, a response body limit of 64 KB, and a short timeout. Any `2xx` is success.
- Failures are recorded on the channel (`last_status`, `last_error`) and counted in `fledge_notification_channels_failing`.
- Customer webhooks must be **public HTTPS**; administrator webhooks may target private addresses and HTTP.
- The URL (which often contains a secret) is stored encrypted and never shown again.

## Failover webhook

The separate webhook under **Settings → Automatic failover** receives node offline/online and recovery events in the same
Slack/Discord/Mattermost-compatible shape.
