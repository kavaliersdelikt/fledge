---
title: Better Discord Notifications
---

# Better Discord Notifications

The bundled **Better Discord Notifications** plugin (`discord-embeds`) turns Fledge's one-line Discord messages into colour-coded cards. It works for the administrators' Discord channels and for the Discord channels that customers add for their own servers.

## What you get

| Style | Looks like |
| --- | --- |
| **Plain text** (always available) | `Fledge: Survival crashed (Survival) — exit code 137, out of memory` |
| **Rich embed** | A card with a colour bar by severity, an emoji, the title as a link to the right page in your panel, the server, the status, the exit code and cause of a crash, a few facts from the event, the last console lines in a code block, and a footer with the event code |
| **Compact embed** | A slim, colour-coded line with the title, the server and the first sentence. Good for busy channels |

For a crash, with the default settings, the plugin returns this (Fledge then sends it to Discord, where it shows as a red card):

```json
{
  "username": "Willow Hosting",
  "allowed_mentions": { "parse": [] },
  "embeds": [{
    "title": "💥 Survival crashed",
    "description": "exit code 137, out of memory",
    "url": "https://panel.willowhost.example/servers/0b6f",
    "color": 15548997,
    "timestamp": "2026-10-04T12:03:12.000Z",
    "author": { "name": "Willow Hosting" },
    "footer": { "text": "Willow Hosting · server.crashed" },
    "fields": [
      { "name": "Server", "value": "Survival", "inline": true },
      { "name": "Status", "value": "Needs attention", "inline": true },
      { "name": "Exit code", "value": "137", "inline": true },
      { "name": "Cause", "value": "Out of memory", "inline": true },
      { "name": "Last output", "value": "```\n[12:03:11] [Server thread/INFO]: Saving worlds\nKilled\n```", "inline": false }
    ]
  }]
}
```

Colours follow severity: red for things that need attention, amber for warnings, green for recoveries and blue for information. You can change all four.

## Turn it on

1. **Plugins → Store → Better Discord Notifications → Install.** It asks for one permission, *Read the text of notifications to lay them out*; it has no network access and no other permission. Turn it on.
2. **Settings → Notifications**, add or edit a **Discord** channel and choose its **Message style**. **Send test** shows the result in Discord. Set up the Discord webhook itself as described in [Discord and webhook notifications](/panel/discord-notifications).
3. Optional: open the plugin's settings.

As soon as the plugin is on, customers see the same **Message style** choice for their own Discord channels. If you turn it off later, channels that use a rich style keep their choice but send plain text until you turn it back on, so no notification is lost.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Sender name | empty | The name Discord shows. Empty uses your panel's name from [Appearance](/panel/appearance) |
| Sender picture | empty | An https link to an image. Empty uses the picture of the Discord webhook |
| Emoji in titles | on | An emoji per kind of event |
| Link titles to the panel | on | The title opens the server (or the nodes, billing or customers page) in your panel |
| Show the time | on | Discord shows it in each reader's time zone |
| Show the event code in the footer | on | For example `server.crashed` |
| Show the last console lines of a crash | on | See the privacy note below |
| Colours | `ED4245`, `F0B232`, `3BA55D`, `5865F2` | Six hex digits each, for attention, warning, recovered and information |
| Discord role to ping | empty | The numeric ID of a role (Discord: turn on Developer Mode, right-click the role, *Copy Role ID*) |
| Ping the role for | things that need attention | Never; things that need attention; or warnings and things that need attention |

## Who can be pinged

Nobody, unless you ask for it. Every message carries `allowed_mentions` that switch mention parsing off, so a server called `@everyone` is just text. The one exception is the **role** you choose above:

- it is pinged only on **administrators' channels**, never on customers' channels;
- only for the severities you choose;
- only a plain numeric role ID is accepted, at most three roles, and Fledge discards anything else the plugin returns.

## Privacy

- A crash message can include the last lines of the server's console. Those can contain player names and chat. If a Discord channel is more public than your panel, turn off **Show the last console lines of a crash**.
- Billing events (a failed payment, a dispute) name a customer's email address. Send them to a private channel.
- The plugin never sees the Discord webhook address; Fledge sends the message itself.

## How it stays safe

The plugin only returns a JSON description of the message. Before anything is sent, Fledge rebuilds it from an allow-list: text is cut to Discord's limits (title 256, description 4,096, 25 fields of 1,024 characters, about 6,000 in total), links must be `http(s)` with no user name or password, pictures must be `https`, only `title`, `description`, `fields`, `footer`, `author`, `thumbnail`, `url`, `color` and `timestamp` are kept, and mention rules are forced as above. If the plugin is off, slow (it has three seconds), crashes or returns nothing usable, the channel receives the plain message instead. See [Notification styles (for plugin authors)](/plugins/notification-styles).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| The *Message style* choice lists only *Plain text* | The plugin is not installed or turned off |
| The message is plain although *Rich embed* is chosen | The plugin is off, failed, or timed out; look at the plugin's log under Plugins |
| Discord shows no colour bar | Discord ignores an embed whose colour is invalid; check the colour settings |
| A role is not pinged | It is a customer channel, the severity does not match, or the ID is not a number |
| The title link opens the wrong address | The panel's public address (`WEB_ORIGIN`) is set to something other than the address you use |

## Source

[`plugins/bundled/discord-embeds`](https://github.com/kavaliersdelikt/fledge/tree/main/plugins/bundled/discord-embeds): about 150 lines, a good starting point for another channel format.
