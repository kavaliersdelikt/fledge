---
title: Notifications
---

# Notifications

The bell in the header opens your **inbox**. Channels send the same events elsewhere.

![The notification inbox](/screenshots/notifications.webp){.screenshot}

## Events

The complete, generated list with scopes and severities is in [Notification events](/reference/events). In short:
crashes and crash loops, recoveries, almost-full disks, failed backups and verifications, failed schedules, failed
add-on installs, failover starting or blocked, nodes going offline or online, failed agent updates, new Fledge versions
and plugins that were switched off.

Repeats are suppressed: the same condition (a node staying offline, a disk staying full) notifies once, not on every
check.

## Channels

Add channels under **Settings → Notifications**:

| Channel | Delivers to |
| --- | --- |
| **Discord** | A Discord webhook URL |
| **Slack** | A Slack incoming webhook URL |
| **Webhook** | Any HTTPS endpoint; a JSON body that is also Slack- and Mattermost-compatible (see [Webhook payloads](/api/webhooks)) |
| **Email** | An address, using the configured [email](/operate/email) settings |

Each channel chooses which events it receives and, optionally, which servers. **Send test** checks a channel; the
channel shows its last delivery status and error.

Webhook URLs are stored encrypted and are never shown again after saving.

## Customers

Customers have their own inbox and channels for events about **their** servers. Their webhooks must be public HTTPS
URLs (private addresses and plain HTTP are refused), and their email channel can only target their own address.
Administrators' channels may use internal addresses, for example a Mattermost server on your LAN.

## Tuning

- `fledge_notification_channels_failing` in [metrics](/operate/monitoring) counts channels whose last delivery failed.
- Inbox entries are kept for a limited time and trimmed automatically.
