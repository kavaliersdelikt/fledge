# Better Discord Notifications

Turns Fledge notifications into good-looking Discord messages: a colour-coded card with the event, the server, the cause of a crash, a few facts and the last console lines, and a title that opens the right page in your panel.

**How it works.** The plugin only lays out the message. Fledge sends it, so the plugin never sees your Discord webhook address and needs no network access. Everything it returns is checked again before it leaves the panel: sizes are cut to Discord's limits, links must be http(s), and nobody can be pinged except a role you chose on an administrator's channel. If anything goes wrong the channel gets the normal one-line message instead, so a notification is never lost.

**Set up**

1. Install and turn on this plugin (Plugins in the sidebar).
2. Open **Settings → Notifications**, add or edit a **Discord** channel and pick **Rich embed** or **Compact embed** as its *message style*. Press **Send test** to see it.
3. Optional: set a sender name and picture, change the colours or choose a role to ping, in this plugin's settings.

Customers get the same choice for their own Discord channels as soon as the plugin is on. Their messages never ping anyone.

**Permissions:** read the text of notifications to lay them out. Nothing else: no network, no storage, no servers.

**Privacy.** Crash messages can include the last lines of the server's console. Those can contain player names. Turn off *Show the last console lines of a crash* if the Discord channel is more public than the panel.
