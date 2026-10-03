---
title: Customers creating servers
---

# Customers creating servers

Until now only administrators created servers. **Settings → Customers, store and email → Customers creating servers** lets customers do it
themselves, in two different ways. It is **off** by default.

![The self-service settings](/screenshots/settings-self-service.webp){.screenshot}

| Mode | What customers can do |
| --- | --- |
| **Off** (default) | Nothing: only administrators create servers |
| **Plans only** | Get servers from [plans](/panel/plans): free plans without payment, paid ones through the [store](/panel/store) |
| **Free choice** | Also create servers freely: pick a kind of server and its size, **within their [limits](/panel/limits)** |

## Free choice

1. Release the **templates** customers may use (tick them in the same card, or per template). Nothing is released by default, so upgrading
   shows customers nothing they did not see before. Add a short description customers read.
2. Set the [limits](/panel/limits). Without limits, a customer could ask for as much as the nodes have; the node capacity check still
   protects the machines, but not the rest of your customers. A good start is a default of 1 server, a memory cap and a disk cap.
3. Choose the **locations** customers may use (empty for all).

![A customer creating their own server](/screenshots/self-service-create.webp){.screenshot}

Customers get **New server** on the Servers page: a kind, a name, the size (memory, CPU and disk within what their limits allow), a location and
the settings the template lets people change. The server is placed exactly as an administrator's would be (capacity, free ports, real free disk), in
the same transaction as the limit check, so two clicks at once cannot exceed a limit. If there is no room, the customer gets a plain "no capacity right
now" and never sees which nodes exist.

Other rules:

- The account must be active and, for people who signed up themselves, have a confirmed email address (administrator-created accounts count as confirmed).
- A customer can create at most 10 servers an hour (change it).
- Customers only see templates you released; their plan can narrow the list and the locations further.
- A customer's plan can switch the right off (**May create servers: No**) without changing the panel setting.

## Deleting a server

With **Customers may delete their own servers** on, the owner (not people the server is shared with) gets a **Delete** button in the server's settings.

- Servers that belong to a **subscription** are not deleted here: they are removed when the subscription ends. The button explains this and links to Billing.
- By default the server is **stopped and kept for 24 hours**, shown as "Deleting soon", and the owner can bring it back with one click. Set the time to 0
  to delete immediately.
- When backups are on, a backup is taken first (unless the owner already has one from the last hour). A failing backup, for example because of a
  backup limit, never blocks a deletion the customer asked for.
- Everything is in the [audit log](/panel/audit).

## What administrators still do

Administrators create servers as before, from **Servers → New server**, for any customer, and are not bound by the customer rules. A customer's limits
still apply to them unless they tick *force* (or you set limits to let administrators always exceed them).

## API

`GET /api/me/servers/options`, `POST /api/me/servers`, `DELETE /api/me/servers/:id` (with `{"confirm": true}`), `POST /api/me/servers/:id/restore`,
`PUT /api/templates/:id/store`. Customers use their browser session; API tokens cannot create servers for customers. See the
[API reference](/api/reference/self-service).
