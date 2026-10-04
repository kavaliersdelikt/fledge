---
title: Discord and webhook notifications
---

# Discord and webhook notifications

Fledge can post what happens on your servers and nodes into a Discord channel, a Slack channel, a Mattermost channel or any URL that accepts JSON. This page is the set-up guide; the general model (inbox, events, who receives what) is in [Notifications](/panel/notifications), and the exact JSON is in [Webhook payloads](/api/webhooks).

## Post to Discord in two minutes

1. In Discord, open the channel's settings: **Edit Channel → Integrations → Webhooks → New Webhook**. Name it (for example *Fledge*), pick the channel and choose **Copy Webhook URL**. You need the *Manage Webhooks* permission on that channel.
2. In Fledge open **Settings → Notifications → Add channel** and choose **Discord**.
3. Give the channel a name, paste the URL, and tick the events you want. Optionally limit it to some servers.
4. Save, then press **Send test**. A message "Test notification" should appear in Discord within a second or two. If not, the channel shows the error beside its last delivery (see below).

The webhook URL is a secret: anyone who has it can post to your channel. Fledge stores it encrypted, shows only its host name afterwards and never returns it from the API. To change it, paste a new one; to revoke it, delete the webhook in Discord.

### What the message looks like

By default one plain line, so it reads well on phones and in notification previews:

```text
Fledge: Survival crashed (Survival) — exit code 137, out of memory
```

The first word is your panel's name from [Appearance](/panel/appearance). The server name follows in brackets when the event is about a server. Messages are cut at 1,900 characters (Discord's limit is 2,000).

**Nobody gets pinged by accident.** Fledge sends `allowed_mentions: { parse: [] }` with every Discord (and generic) message, so a server, customer or plan called `@everyone` or `<@role>` shows as text and notifies no one. If you *want* a ping, put it in the Discord channel's own rules or use a Discord bot; Fledge does not add mentions.

## Rich embeds

With the bundled [Better Discord Notifications](/plugins/discord-embeds) plugin turned on, a Discord channel (yours, or a customer's) can use a **Message style**: **Rich embed**, a colour-coded card with the server, the cause, a link to your panel and the last console lines, or **Compact embed**, a slim line. Choose it in the channel editor; **Send test** shows the result. If the plugin is off or fails, the channel falls back to the plain line, so nothing is lost. Mentions stay blocked in every style; the plugin can optionally ping one role you choose, on administrator channels only.

## Slack and Mattermost

| Channel kind | Paste | Notes |
| --- | --- | --- |
| **Slack** | An *incoming webhook* URL (`https://hooks.slack.com/services/…`) | Sends `{"text": …}` |
| **Webhook** | A Mattermost *incoming webhook* URL, or any other endpoint | Sends the generic payload, which includes `text` and `content`, so Slack-, Discord- and Mattermost-compatible endpoints work unchanged |
| **Discord** | The webhook URL from Discord | Sends `{"content": …, "allowed_mentions": …}` |

Use **Webhook** when you want the full structured event (`event.kind`, severity, server, data) for your own automation, for example to open a ticket or to feed a chat bot. See [Webhook payloads](/api/webhooks) for the fields and for how to verify and handle them.

## Choosing events

Each channel picks the events it receives. Good starting points:

| Audience | Suggested events |
| --- | --- |
| Operations channel | Node offline/online, failover started/blocked, backup failed, agent update failed, new Fledge version, plugin turned off |
| Support channel | Server crashed, crash loop, recovered, disk almost full, schedule failed, add-on failed |
| Business channel | A new customer is waiting for approval, A customer's payment failed, A paid server could not be created, A customer opened a payment dispute, Billing needs attention |

The list is generated from the code in [Notification events](/reference/events). Events about a **server** can also be limited to chosen servers, which is useful for one Discord channel per community.

Repeated conditions notify once: a node that stays offline does not post every minute.

## For customers

Customers can add their own channels under **Settings → Notifications**, for events about their own servers, for example to get crash alerts in their community's Discord. Differences from the administrator's channels:

- The URL must be **public HTTPS**. Private addresses, plain HTTP and URLs with a user name or password are refused.
- Only server events are offered (nothing about nodes or billing).
- Customers can pick a message style for their Discord channels when the plugin is on. A customer can have at most **10** channels, and an email channel can only go to their own address.

Tell your customers that a Discord webhook URL is a password for their channel, and that a collaborator on a server also receives that server's events on their own channels, not on the owner's.

## When a channel stops working

Each channel shows **last delivery**: *sent* or *failed* with a short reason, and the time.

| Reason | What to do |
| --- | --- |
| The endpoint answered 404 | The webhook was deleted in Discord. Create a new one and paste it |
| The endpoint answered 401 or 403 | The URL is incomplete (a copied URL must include the long token after the last `/`) |
| The endpoint answered 429 | Discord is rate limiting you. Choose fewer events or split channels. Fledge does not retry notifications in a tight loop |
| Address not allowed / private address | A customer channel points at an internal address. Use a public HTTPS URL |
| Timed out | The endpoint took longer than 8 seconds or returned more than 64 KB |

Fledge does not follow redirects for webhooks, so use the final URL. Notifications are best effort: if Discord is unreachable the inbox in the panel still has the event, and `fledge_notification_channels_failing` in the [metrics](/operate/monitoring) counts channels whose last delivery failed, so you can alert on it.

## Failover webhook

The separate webhook under **Settings → Automatic failover** sends node-offline, node-online and recovery events in the same Discord-, Slack- and Mattermost-compatible shape. Use a notification channel for everything else.

## Via the API

```sh
curl -X POST "$PANEL/api/notification-channels" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"discord","name":"Ops","url":"https://discord.com/api/webhooks/…","events":["node.offline","node.online","backup.failed"]}'
```

`POST /api/notification-channels/:id/test` sends a test message. See the [API reference](/api/reference/notifications).
