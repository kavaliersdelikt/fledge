---
title: Schedules
---

# Schedules

**Server → Automation** runs chains of steps on a timer: nightly restarts, hourly `save-all`, a warning before a
restart, a backup before an update. Owners and collaborators with `manage` can edit them.

![The schedule editor](/screenshots/schedule-editor.webp){.screenshot}

## When it runs

| Type | Configuration |
| --- | --- |
| **Cron** | A five-field expression (`minute hour day-of-month month day-of-week`) and a **time zone** (IANA name such as `Europe/Berlin`). The editor shows the next five run times. |
| **Interval** | Every *N* minutes (minimum 5) |

A schedule can run at most once every five minutes. A server can have up to 20 schedules.

## Steps

A schedule is a chain of up to 20 steps that run in order:

| Step | Parameters | Notes |
| --- | --- | --- |
| **Command** | One line, up to 1024 characters | Sent to the console like a typed command |
| **Wait** | 1 to 3600 seconds | Waits before the next step; all waits together may add up to 6 hours |
| **Backup** | none | Takes a backup (needs [object storage](/operate/backups); counts against the backup quota) |
| **Power** | `start`, `stop`, `restart` or `kill` | |

Example, a polite nightly restart:

1. Command `say Restarting in 60 seconds`
2. Wait `60`
3. Backup
4. Power `restart`

## Missed runs

If the panel was down at the scheduled time, the schedule's **missed** policy decides: *skip* (default; the run is
recorded as skipped) or *run once* when the panel is back. A due run that finds the previous run of the same schedule
still in progress is recorded as skipped; a schedule never has two runs at once.

## Run now and history

**Run now** starts a manual run. Every run keeps its history: state, step results, error, trigger (schedule or
manual) and times; history is kept for 30 days. A failed step stops the run, marks it failed and raises a
`schedule.failed` [notification](/panel/notifications).

## How it executes

Runs are persistent: a run claims its next step with a 90-second lease, so another API process can continue it if
one dies. Steps that need the node are queued as jobs and execute in order per server. A step does not wait for the
game to *finish* a command, and a run interrupted by an API crash may repeat its current step.

Stopping from a schedule is not a crash for [crash protection](/panel/crash-protection).

API: [Schedules endpoints](/api/reference/).
