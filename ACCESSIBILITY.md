# Accessibility

Fledge aims to make its web panel and documentation usable by as many people as practical, including people who navigate with a keyboard, use assistive technology, need increased contrast, or prefer reduced motion.

Accessibility is an ongoing part of development rather than a completed certification. Fledge has **not** undergone a formal third-party accessibility audit, and this statement should not be read as a claim of full conformance with WCAG or another accessibility standard.

## What Fledge currently does

The project includes accessibility-oriented behaviour throughout the panel and documentation, including:

- visible keyboard focus styles;
- semantic labels and ARIA attributes for many controls, regions, charts, notifications, and status elements;
- keyboard navigation in interactive areas such as the command palette and other complex controls;
- support for the operating system or browser `prefers-reduced-motion` preference;
- light, dark, and high-contrast appearance options;
- contrast checks in the appearance editor for configurable themes;
- an Atkinson Hyperlegible font option alongside the other bundled fonts;
- responsive layouts intended to remain usable on smaller screens.

Contributors changing user-facing interfaces should preserve these behaviours and consider keyboard access, focus management, accessible names, colour contrast, motion, zoom/reflow, and assistive-technology output.

## Supported environments

Fledge is a browser-based application. The project is intended to work with current, standards-compliant desktop and mobile browsers.

The panel is developed primarily around modern browser capabilities used by Next.js and React. Accessibility behaviour can vary by browser, operating system, screen reader, input device, and custom Fledge theme.

The Linux-only requirement for Fledge node agents does not limit which operating system may be used to access the web panel.

Because the project is still under active development, not every browser and assistive-technology combination is continuously tested. If an accessibility problem occurs in an otherwise current browser or assistive-technology setup, please report it even if that exact combination is not listed in project testing.

## Known limitations

Known or potential accessibility limitations include:

- Fledge has not completed a comprehensive WCAG conformance audit.
- Screen-reader testing is not yet comprehensive across the full panel.
- Browser VNC, serial consoles, terminal-style server consoles, charts, and other highly interactive interfaces may be less accessible than standard form and navigation screens.
- Custom branding and especially custom CSS can reduce readability, hide controls, change focus presentation, or otherwise make an installation less accessible.
- The built-in Fledge dark appearance retains a lower-contrast hint/placeholder treatment than the project's calculated palettes. Other presets and the high-contrast option apply stronger contrast floors.
- Third-party content, game-server output, plugins, or external services shown or linked through Fledge may have accessibility characteristics outside Fledge's control.
- Some accessibility defects may exist even where semantic markup or ARIA attributes are present; automated or code-level checks do not replace testing with people and assistive technologies.

We want to improve these areas over time. Accessibility fixes are welcome contributions.

## Report an accessibility barrier

If you encounter an accessibility barrier in Fledge, please [open a GitHub issue](https://github.com/kavaliersdelikt/fledge/issues/new).

Include as much of the following as you are comfortable sharing:

- the page or feature where the problem occurs;
- what you expected to be able to do;
- what happened instead;
- steps that reproduce the problem;
- browser and operating system;
- assistive technology or input method, if relevant;
- screenshots or a short recording when they help explain the problem.

Please do **not** include passwords, API keys, cookies, enrollment tokens, backup URLs, private customer information, or other secrets in a public report.

If the accessibility problem also exposes a security or privacy vulnerability, **do not report it publicly**. Use [GitHub Security Advisories](https://github.com/kavaliersdelikt/fledge/security/advisories/new) and follow [SECURITY.md](SECURITY.md).

## Contributing accessibility improvements

Accessibility improvements can be proposed through issues and pull requests like other changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and testing workflow.

For user-interface changes, useful checks include:

- completing the task with a keyboard alone;
- confirming focus is visible and moves in a logical order;
- checking that icon-only controls have useful accessible names;
- confirming validation and status messages are not conveyed by colour alone;
- testing light, dark, and high-contrast appearances;
- enabling reduced motion;
- increasing browser zoom and testing narrow layouts;
- trying the changed flow with a screen reader when possible.

Accessibility reports and improvements are treated as product-quality work, not cosmetic requests.
