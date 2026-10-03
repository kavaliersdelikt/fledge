---
title: Audit log
---

# Audit log

**Activity** (administrators) records who did what: sign-ins and changes, server actions, backups and restores, plugin
installs and add-on changes, settings changes, customer management and more. Each entry has the time, the actor's email,
the action name, the target and some details.

![The audit log with filters](/screenshots/activity.webp){.screenshot}

## Filters

Filter by **action** (for example `server.stop`, `plugin.install`), **person**, **target type** and id, a **date range** and
free **text**. The same filters apply to exports.

## Export

**Export CSV** and **Export JSON** download the filtered entries. The CSV is protected against spreadsheet formula
injection (cells starting with `=`, `+`, `-` or `@` are neutralised).

## Retention

Under **Settings → Panel → Security**, *Keep the audit log for (days)* deletes older entries automatically. `0` keeps
everything.

## API

`GET /api/activity` accepts `action`, `actor`, `targetType`, `targetId`, `from`, `to`, `q`, plus `limit` and `offset`, and
returns the actor's email. See the [endpoint reference](/api/reference/).
