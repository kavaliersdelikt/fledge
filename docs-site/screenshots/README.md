# Documentation screenshots

`npm run screenshots` takes every screenshot used by the docs from a **demo stack with fictional data**: a real API and plugin host
against an empty throw-away database, the production build of the panel, and three simulated nodes. No real installation, customer
or credential is involved; the demo administrator (`maya@fledge.demo`) and every customer are made up.

## Run it

```sh
# prerequisites (once)
cd api && npm ci && cd ../plugins/host && npm ci
cd ../../web && npm ci && NEXT_PUBLIC_API_URL=http://localhost:4300 npm run build
cd ../docs-site && npm ci

# take them (needs PostgreSQL and a Chrome/Chromium)
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm run screenshots
ONLY=nodes,files npm run screenshots       # only some
CHROME_PATH=/usr/bin/chromium npm run screenshots
```

`NEXT_PUBLIC_API_URL` is compiled into the panel build, so build it with the demo API address (`http://localhost:4300`) before
running. The run needs internet access: the Modrinth plugins browse the real Modrinth catalog.

Files are written to `docs/public/screenshots/*.webp` (encoded by the browser, no extra tools). Failed shots leave
`_failed-<name>.png` next to them for inspection; delete these.

## Files

- `demo.mjs`: boots the stack and seeds the data (nodes, customers, servers, add-ons, schedules, notifications, history). The simulated agents
  heartbeat, answer jobs and stream console lines like real ones.
- `shots.mjs`: one function per screenshot. Wait for visible text rather than fixed times.
- `shots.appearance.mjs`: the appearance screenshots and the themed panels used on the landing page. They come last because they change the look of the whole demo panel; they use a fictional brand ("Lumen Hosting", logo in `assets/lumen-mark.svg`) and wait a few seconds after each change because the panel caches the appearance briefly.
- `run.mjs`: the runner (browser, sign-in, WebP encoding).
- `keep.mjs`: starts the same seeded demo and keeps it running (it writes the session cookie to `demo-session.json`), for looking around by hand.
- `regress.mjs`: records the computed style of every element on every screen and compares two recordings, to prove that a stylesheet refactor changes nothing (see [Tests](../docs/dev/tests.md)).

## Adding a screenshot

Add an entry to `shots.mjs`, run it with `ONLY=<name>`, look at the result, then reference it from a page with
`![Meaningful alt text](/screenshots/<name>.webp){.screenshot}`. `npm run check` fails for missing files or empty alt text.

When the UI changes noticeably, re-run the whole set and commit the new files.
