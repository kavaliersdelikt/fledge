---
title: Testing plugins
---

# Testing plugins

## Against the real sandbox

The plugin host exports `runPlugin`, the same function the container uses. A test starts a small local HTTP server that
plays your catalog, then calls your methods inside the sandbox:

```ts
import { runPlugin } from '../plugins/host/src/sandbox.ts';

const out = await runPlugin({
  code,                                   // the contents of index.js
  method: 'search',
  args: [{ query: '', offset: 0, limit: 24 }, { kind: 'mod', loaders: ['fabric'], gameVersion: '1.21.4' }],
  plugin: { id: 'my-plugin', version: '1.0.0' },
  settings: { indexUrl: 'http://127.0.0.1:' + port + '/catalog.json' },
  storage: {},
  network: ['127.0.0.1'],
  guard: { allowPrivate: true, allowHttp: true },   // test-only: the real host refuses both
});
```

`out.result` is the JSON your method returned; `out.logs` has your `host.log` lines; a failure throws a `PluginError` with a
`code` (see [Limits and errors](/plugins/limits)).

The documentation's own [`check-examples.ts`](https://github.com/kavaliersdelikt/fledge/blob/main/docs-site/scripts/check-examples.ts)
does exactly this for the tutorial plugin and also validates the manifest with the panel's rules and builds the package.

## End to end

`api/test/plugins-smoke.mjs` boots a real API and plugin host against a throw-away database and a **Modrinth mock**
(`api/test/modrinth-mock.mjs`, shaped like the real API) and exercises install, consent, settings, browsing, dependency
planning, install/update/rollback-safe jobs, disable and remove. Copy the idea for your own source. Run it with
`npm run test:plugins` in `api/` (needs PostgreSQL; see [Tests](/dev/tests)).

## Checklist

- `healthCheck` answers quickly and clearly when the source is down.
- Every `resolve` answer has an `https` URL on a declared host, a safe `*.jar` file name, a 128-character `sha512` and a size
  between 1 byte and 256 MB.
- Errors you throw are written for the administrator who will read them.
- You never rely on timers, `fetch`, `require`: they do not exist.
- A call finishes well within 25 seconds, even when the source is slow.
