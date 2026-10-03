# Fledge documentation site

Built with [VitePress](https://vitepress.dev) and published to GitHub Pages by `.github/workflows/docs.yml`.

```sh
cd docs-site
npm ci
npm run dev        # generate the references, then serve at http://localhost:5173/fledge/
npm run build      # generate and build into docs/.vitepress/dist
npm run check      # code blocks, screenshots, API coverage
npm run examples   # run the tutorial plugin in the real plugin sandbox
npm run landing    # serve the landing page alone at http://localhost:4173/
```

The home page is not a VitePress page. It is hand-written HTML, CSS and JavaScript in `landing/` (no build step, no
dependencies). `landing/blackhole.js` is the WebGL2 ray tracer behind the hero. `npm run build` copies `landing/` over the
build output after VitePress, so it becomes `index.html`. The fonts in `landing/fonts/` (Unbounded, Hanken Grotesk, Latin
subsets) are self-hosted under the SIL Open Font License, and their licence texts sit next to them.

The generators import code from `api/` and `plugins/host/`, so install their dependencies first (`npm ci` in `api` and `plugins/host`,
and `plugins/tools` for the examples). `npm run snapshot` boots a real API against an empty PostgreSQL database
(`TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres`) and saves its OpenAPI description, which the API reference is generated from.

Read [Writing these docs](docs/dev/docs.md) for the conventions, what is generated and how screenshots are taken
(`npm run screenshots`, see `screenshots/README.md`).

Published at <https://kavaliersdelikt.github.io/fledge/>.
