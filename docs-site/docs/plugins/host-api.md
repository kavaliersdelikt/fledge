---
title: The host API
---

# The host API


Available as a global inside the sandbox.

| | |
|---|---|
| `host.settings` | Your settings (secrets included, decrypted only for you) |
| `host.context` | `{ pluginId, version, panelVersion }` |
| `await host.fetch(url, { method, headers, body })` | `GET`, `HEAD` or `POST`. Returns `{ status, ok, headers, text(), json() }`. HTTPS only, default port, host must be declared, no private addresses, up to 3 redirects (each re-checked), 8 MB per response, 24 MB and 40 requests per call. Rejects with an `Error` (`e.code`: `host-denied`, `rate-limit`, `timeout`, …) |
| `host.storage.get(key)` / `.set(key, value)` / `.delete(key)` | Needs the `storage` permission. Synchronous; changes are saved when the call returns |
| `host.log(level, …)` / `console.log(…)` | Appears in the plugin's **Logs** tab (last 500 lines) |

There is no `setTimeout`, no `fetch`, no `require`/`import`, no `process`, no `Buffer`. `JSON`,
`Promise`, `async/await`, `encodeURIComponent` and the rest of the ECMAScript 2023 standard library work.
