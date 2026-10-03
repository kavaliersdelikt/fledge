---
title: Concepts
---

# Concepts

| Term | Meaning |
| --- | --- |
| **Administrator** | A provider account. Can manage nodes, customers, templates, plugins and settings. Must use two-factor sign-in. |
| **Customer** | A normal account that owns servers. Limited by an optional [quota](/panel/customers). |
| **Collaborator** | A user invited to one server with some of `view`, `console`, `files`, `backups`, `manage`. |
| **Node** | A Linux host running Docker and the Fledge agent. Has a capacity (memory, CPU, disk) and a location label. |
| **Server** | One game server container plus its data volume, owned by a customer and placed on a node. |
| **Template** | A recipe for a kind of server: image, startup command, ports, environment, variables, default resources. Templates are versioned. |
| **Job** | A durable unit of work for a node (create, start, stop, backup, file operations...). The agent polls for jobs and reports results. |
| **Allocation** | A host port reserved for a server on a node. A server's base port plus offsets from its template and extra ports. |
| **Add-on** | A mod or plugin file installed into a server's folder by a catalog plugin, tracked by the panel. |
| **Plugin** | A sandboxed program that extends the panel (today: add-on catalogs, event hooks and payment providers). |
| **Schedule** | A cron or interval rule that runs a chain of steps on a server (command, wait, backup, power). |
| **Limits** | What a customer may own. Layered: panel defaults, plans, and per-customer overrides. Can be switched off. See [Limits](/panel/limits). |
| **Plan** | Something you sell or give: a *server plan* creates one server per subscription, an *account plan* adds to a customer's limits. See [Plans](/panel/plans). |
| **Subscription** | A customer's hold on a plan, paid through a payment provider (or given for free). Its status controls the server. See [Billing](/panel/billing). |
| **Store** | Where customers buy plans. Closed until everything it needs works. See [The store](/panel/store). |
| **Payment provider** | A [plugin](/plugins/payments) that talks to Stripe or another provider. Fledge keeps the orders and entitlements. |
| **Failover** | Re-creating a server from its newest backup on another node after its node has been silent too long. |
| **Resilience** | The page that shows backup freshness, failover readiness and history. |

## Lifecycle of a server

```mermaid
sequenceDiagram
    participant U as User
    participant A as API
    participant N as Node agent
    U->>A: Create server (template, owner, resources)
    A->>A: Pick a node with room, reserve ports
    A->>N: create job (via polling)
    N->>N: Make the data volume, start the container
    N->>A: Result and heartbeat (running)
    U->>A: Console, files, backups
    A->>N: More jobs
```

Everything the panel asks of a node is a job. Jobs are leased, can be retried, and are idempotent where it matters, so
a lost connection does not lose or duplicate work.
