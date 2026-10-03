---
title: Startup panel
---

# Startup panel

**Settings → Startup** shows what a server actually starts with:

- the container **image**,
- the **start command** (administrators only),
- the **environment**, merged from the template and the server's own variables, with where each value comes from,
- the **port layout**.

![The startup panel](/screenshots/startup.webp){.screenshot}

## Editable variables

A template can declare [typed variables](/panel/templates#variables) that owners may change (for example slots, game
mode, a password). They appear here as form fields with labels, help text and validation (number ranges, choices,
patterns, on/off switches, secrets). Saving **recreates the container** with its files, so the server restarts. A server
that is stopped stays stopped: the container is recreated and then stopped again.

Only variables the template declares as user-editable can be changed, and values are validated on the server, not just
in the form.

## What customers see

Owners see the image and the variables they may edit. They do **not** see the start command or template-level
environment that no declared variable surfaces. Secret variables are hidden from everyone but administrators.
