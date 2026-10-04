---
title: Notification styles
---

# Notification styles

Since 0.8.1.1 a plugin can lay out notifications for a kind of channel. The bundled [Better Discord Notifications](/plugins/discord-embeds) plugin is the first one. A style plugin is a **formatter**: it receives an event and returns the body of the message. **Fledge sends it**, so the plugin never sees the channel's address and needs no `network:` permission.

## Manifest

```json
{
  "id": "discord-embeds",
  "permissions": ["notifications"],
  "notifications": {
    "channel": "discord",
    "styles": [
      { "id": "embed", "label": "Rich embed", "description": "Colour-coded card with fields." },
      { "id": "compact", "label": "Compact embed" }
    ]
  }
}
```

| Field | Rules |
| --- | --- |
| `notifications.channel` | `discord` (the only kind so far) |
| `notifications.styles` | 1 to 5 styles. `id` is lowercase letters, numbers and hyphens and must not be `plain` (that is the built-in style); `label` is shown in the channel editor |
| permission `notifications` | Required with the capability, and only allowed with it |

The permission is described to administrators as *Read the text of notifications to lay them out as rich messages. It cannot send anything anywhere and never sees the webhook address.* Event text can contain server names, console output and (for billing events) customers' email addresses, so a formatter should be treated like any plugin that reads your data.

If several enabled plugins declare the same channel kind, the first by id is used.

## The method

```js
globalThis.fledgePlugin = {
  formatNotification: function (input) {
    // return the JSON body of a Discord webhook message
  }
};
```

`input`:

| Field | Meaning |
| --- | --- |
| `channel` | `discord` |
| `style` | The style id the channel uses (one of yours) |
| `scope` | `panel` for an administrator's channel, `user` for a customer's |
| `brand` | The panel's name from Appearance |
| `panelUrl` | The panel's public address without a trailing slash, for links |
| `event` | `{ kind, severity, title, body, server: {id,name}|null, nodeId, data, at }`. `severity` is `ok`, `info`, `warn` or `bad`. `data` is event specific and cut to 8 KB. The full list of kinds is [Notification events](/reference/events) |

`host.settings` holds the plugin's settings, as everywhere. There is no `host.fetch` to use without a `network:` permission, and none is needed.

Return an object with any of `content`, `username`, `avatar_url`, `embeds` and `allowed_mentions`. Throwing, returning something else or taking more than **3 seconds** makes Fledge send the plain message.

## What Fledge does with the result

Whatever you return is **rebuilt from an allow-list** (see `api/src/notification-styles.ts`):

- `content` is cut to 2,000 characters, `username` to 80; `avatar_url` must be https.
- Up to **3 embeds**, each keeping only `title` (256), `description` (4,096), `url` (http/https), `color` (0 to 16777215), `timestamp`, `author`, `footer`, `thumbnail` (https) and up to 25 `fields` (name 256, value 1,024). The whole message is held to about 6,000 characters and fields that no longer fit are dropped.
- **Mentions**: `allowed_mentions.parse` is always empty. `allowed_mentions.roles` is honoured only when `scope` is `panel`, only for numeric ids, at most three. Users and `@everyone` can never be mentioned.
- Anything else (`tts`, `components`, `flags`, files) is dropped. A message with neither content nor embeds counts as "nothing usable".

## Channels and the API

A Discord channel has a `style` (`plain` by default). `GET /api/notification-styles` returns `{ "discord": [{ id, label, description? }] }`: `plain` plus the styles of the enabled formatter. `POST` and `PATCH /api/notification-channels` accept `style`; an unknown name is `400`, a well-formed name whose plugin is not available is `409`. A channel keeps its style when the plugin is switched off and sends plain text meanwhile.

## Testing a formatter

`plugin.js` is plain JavaScript, so you can run it in `node:vm` with a fake `host` and feed the output through `cleanDiscord`: see `api/test/discord-embeds.test.ts`. The end-to-end check is `api/test/discord-smoke.mjs` (`npm run test:discord`).
