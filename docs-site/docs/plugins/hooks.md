---
title: Hooks
---

# Hooks


```js
globalThis.fledgePlugin = { hooks: { 'server.created'(event) { host.log('info', 'new server ' + event.serverId); } } };
```

Events: `server.created`, `server.deleted`, `server.updated`, `addon.installed`, `addon.removed`.
Hooks run best-effort with an 8 s limit; their result is ignored.
