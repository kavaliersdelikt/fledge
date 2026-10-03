---
title: Live console WebSocket
---

# Live console WebSocket

`wss://<panel>/api/servers/:id/live` streams a server's console and resource samples to the browser. It needs the
`fledge_session` cookie, a matching `Origin` header (`WEB_ORIGIN`), and the `console` permission on the server. Bearer
tokens are refused (`403`). Commands are **not** sent over this socket; use the HTTP command endpoint
(`POST /api/servers/:id/console`).

On connect the server sends a `status` frame and the last 100 log frames, then live frames. Frames are JSON text:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `status` | `connected: boolean` | Whether the node's console stream is connected (re-sent every 10 s) |
| `log` | `serverId`, `data` (base64 bytes, up to 32 KB) | Console output |
| `sample` | `serverId`, `cpuPercent`, `memoryBytes`, `memoryLimitBytes` | A resource sample |

Access is re-checked every 10 seconds; losing the permission closes the socket.

## Behind a proxy

The proxy must forward WebSocket upgrades. See [Reverse proxy](/operate/reverse-proxy).

## Node side

Agents connect **outbound** to `wss://<panel>/api/agent/stream` with `Authorization: Bearer <credential>` and `X-Node-ID`.
They send the same `log` and `sample` frames for the servers the panel is interested in. With several API replicas, events are
relayed through PostgreSQL (`console_events`, `console_interests`, `console_nodes`) and a node's stream is leased to one
replica at a time.
