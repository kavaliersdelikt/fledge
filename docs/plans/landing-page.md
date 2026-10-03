# Plan: custom landing page for the docs site

Goal: replace the VitePress home page with a hand-built page at `https://kavaliersdelikt.github.io/fledge/`, with a real-time
3D black hole as the hero. The docs stay where they are (`/fledge/guide/...` and so on) so no existing link breaks.

## Approach

- **No framework, no new dependency.** Plain HTML, CSS and ES modules in `docs-site/landing/`. The black hole is a raw WebGL2
  fragment shader, so there is nothing to install (the disk is nearly full, and it keeps the page light: about 40 KB of code
  plus the existing screenshots).
- **Build:** `vitepress build` runs as before; `scripts/landing.mjs` then copies `landing/` into the build output as
  `index.html`. `docs/index.md` is removed so VitePress does not generate its own home. The logo in the docs header links to
  the landing page with a full page load (`logoLink` with `target`, which the VitePress router does not intercept).
- **Dev:** `npm run landing` starts a tiny static server for `landing/` that also serves `docs/public` (screenshots, logo).

## The black hole

The shader traces one light ray per pixel through Schwarzschild space-time:

- It integrates the photon's path with the standard acceleration `-1.5 h² r / |r|⁵` (h is the angular momentum), with step
  sizes that shrink near the hole. The lensing, the Einstein ring and the photon ring all come from this integration; none of it is a 2D trick.
- **Accretion disk:** detected wherever the path crosses the disk plane, including after bending, so the back of the disk
  shows above and below the shadow. The disk has a temperature profile, Keplerian rotation (inner rings turn faster), noise
  streaks and relativistic Doppler beaming (the approaching side is brighter and bluer).
- **Background:** a procedural starfield and a violet nebula, sampled along the bent ray so stars smear around the hole.
- ACES tone mapping, film grain, and a vignette.
- **Camera:** an intro dolly, mouse parallax, and scroll control (the camera tilts toward the disk plane while the hero
  scrolls away).
- **Performance:** rendered at an adaptive resolution that follows the measured frame time. It pauses when the tab is hidden.
  With `prefers-reduced-motion` it renders one still frame. Without WebGL2 a CSS fallback is shown.

## Page sections

1. Navigation: Docs, Plugins, API, Releases, GitHub, Discord.
2. Hero: the version badge, a headline, the one-command install with copy and an OS switch, and calls to action.
3. Strip of supported templates (Minecraft Java and Bedrock, Valheim, Node, Python, Go, Bun, .NET, Pterodactyl eggs).
4. How it works: an animated diagram with nodes in orbit, each agent dialling out to the panel, and no inbound ports.
5. Product tour: tabbed real screenshots in a browser frame that tilts with the mouse.
6. Feature bento: disk limits, backups and failover, autopilot, plugins, security, API.
7. Plugins deep dive: the sandbox limits shown as figures.
8. An honest status note, a final call to action, and the footer.

All claims come from the docs and release notes; nothing is invented.

## Verification

- Load the page in the built-in browser at desktop and phone widths, check the console for errors, and take screenshots.
- `npm run build` plus `npm run check`; the CI docs workflow runs the same build.
