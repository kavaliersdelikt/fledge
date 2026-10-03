---
title: Writing these docs
---

# Writing these docs

The site is [VitePress](https://vitepress.dev), in `docs-site/`, published to GitHub Pages.

```sh
cd docs-site
npm ci
npm run dev        # generates the references, then serves with hot reload at http://localhost:5173/fledge/
npm run build      # generates and builds into docs/.vitepress/dist
npm run check      # link, code block, example and coverage checks
```

## What is generated

Run `npm run generate` to rebuild everything below from the repository:

| Output | Source |
| --- | --- |
| `docs/api/reference/*` | `generated/openapi.json`, made by `npm run snapshot` (boots a real API against an empty database; needs `TEST_DATABASE_URL`) |
| `docs/reference/environment.md` | `.env.example`, `compose.yaml`, a scan of the code and `scripts/env-descriptions.json` |
| `docs/reference/plugin-manifest.md` | `api/src/plugins/manifest.ts`, `plugins/host/src/sandbox.ts` |
| `docs/reference/events.md` | `EVENTS` in `api/src/notifications.ts` |
| `docs/reference/schema.md` | `db/schema.sql` |
| `docs/reference/jobs.md` | `agent/main.go` and `scripts/job-descriptions.json` |
| `docs/releases/*` | `docs/releases/*.md` |

Generated files are git-ignored. **Never edit them**; change the source. When you add an environment variable or an agent job
kind without describing it, generation fails and says which.

## Examples that are tested

Code in the tutorial comes from `docs-site/examples/`, and `npm run examples` runs those plugins in the real sandbox. Include
tested files with VitePress snippets:

```md
<<< @/../examples/tiny-catalog/index.js{js}
```

## Screenshots

Screenshots are taken from a seeded demo stack with fictional data: `npm run screenshots` starts a throw-away API and panel, seeds it,
drives a headless browser and writes optimized WebP files into `docs/public/screenshots/`. See `docs-site/screenshots/README.md`.
Pages reference them with standard Markdown image syntax, the path `/screenshots/<name>.webp` and the CSS class `.screenshot`; alt text is required.

## Style

- English, second person, present tense; short sentences; say what happens, not what the code is.
- One page, one topic. Link instead of repeating.
- Use `::: warning` for data-loss and security hazards, `::: tip` for shortcuts.
- Name UI elements exactly as they appear, in **bold**.
- State limits honestly. If something is untested or evaluation-grade, say so.
- Front matter `title` on every page. Avoid bare angle brackets and double curly braces in prose; put them in code blocks.

## Checks (`npm run check`)

- every internal link resolves (the build fails on dead links),
- every fenced `sh`/`bash` block parses with `sh -n`, every `json` block parses,
- every screenshot referenced exists and has alt text,
- the examples pass,
- the number of undocumented API operations has not grown (see `scripts/coverage-baseline.json`).
