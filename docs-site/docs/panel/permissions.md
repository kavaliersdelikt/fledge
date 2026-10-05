---
title: Customer permissions
---

# Customer permissions

What a customer may do is decided in three places. This page shows how they fit together, so you can answer "why can (or can't) this person do that?" in under a minute.

| Where | What it decides | Set under |
| --- | --- | --- |
| **The panel switch** | Which features exist at all: sign-up, creating servers, the store, billing | [Settings → Customers & billing](/panel/settings) |
| **Limits and permissions** | How much, and what a customer may do: the layered numbers and the **What they may do** switches | [Limits](/panel/limits), [Plans](/panel/plans), [Customers → Edit limits](/panel/customers) |
| **The server** | Who may touch one server: the owner, and collaborators with chosen rights | [Customers → Collaborators](/panel/customers#collaborators) |

Administrators are never limited by this page. Everything below is about customers.

## The "What they may do" switches

Each switch has three states: **Yes**, **No**, or empty (use what is below). They exist on all three layers of [Limits](/panel/limits): the panel defaults, an account plan, and one customer.

| Switch | Lets the customer |
| --- | --- |
| **May create servers** | Create servers themselves, from the kinds you released |
| **May delete their own servers** | Delete their servers (after the cooling-off period). Needs deleting to be turned on in the panel settings |
| **May use SFTP** | Use an SFTP client for files |
| **May install mods and plugins** | Use the add-on browsers on a server |
| **May schedule tasks** | Create schedules (automatic backups, commands) |
| **May share servers** | Add other people to a server |
| **May add extra ports** | Add ports, within the extra-ports limit |

How the layers combine:

1. A **panel default** applies to everyone.
2. An **account plan** a customer has (while it is trialing, active or in its payment grace period) can turn a switch **on**. If several plans disagree, **Yes** wins.
3. A **per-customer value** (Customers → Edit limits) beats both, including **No**. Use it to give one person a right, or to take one away.

**Edit limits** shows what applies *now* and where each value comes from (default, plan or "set by you"), so nothing needs to be worked out by hand. If limits are switched off, switches that say **No** are ignored (see [Limits](/panel/limits)).

## Who may create servers

The panel's **What customers can do** setting (Settings → Customers & billing → Server access) is the master switch for creating servers. **May create servers** then decides *who*.

| Panel mode | Everyone | Customers with a plan that says Yes | Customers you gave **Yes** | Customers set to **No** |
| --- | --- | --- | --- | --- |
| **Off** | No | No | No | No |
| **Server plans** (store only) | No, they buy a server plan | No | **Yes**, fixed size | No |
| **Account plans** | No | **Yes**, fixed size | **Yes**, fixed size | No |
| **Free choice** | **Yes**, they choose the size within limits | Yes | Yes | No |

Where creation is not allowed the **New server** button is hidden. A customer who has the right but no servers sees a short guide instead; customers without it are pointed to the store if you run one.
The panel checks this again every time the page is shown or becomes active, so a change you make arrives without anyone signing in again.

Whatever the mode, a created server still has to pass the customer's [limits](/panel/limits), the allowed locations and templates, the hourly creation rate and the account checks (active, and a confirmed email address for people who signed up themselves).

### Giving one customer the right

1. **Customers**, open the customer, **Edit limits**.
2. Under **What they may do**, set **May create servers** to **Yes**.
3. Make sure you released at least one template ([Customers creating servers](/panel/self-service)) and that the customer has room in their limits. A customer with a servers limit of 0 sees the button and is then told which limit stops them.

To take it away again, set it to **No** (always wins) or clear it to return to the layers below.

## Who may buy

Buying is separate from creating. With the [store](/panel/store) open, any signed-in customer may buy a plan, subject to the plan's own rules (stock, a per-customer maximum, terms accepted) and your sign-up settings. A purchased server is owned by the customer but **belongs to the subscription**: it does not count toward their server limit, cannot be deleted by them while the subscription runs (they cancel it instead), and stops if a payment fails for too long. See [Billing and subscriptions](/panel/billing).

## Billing access

| | Administrators | Customers |
| --- | --- | --- |
| Billing overview, all subscriptions, invoices, health | Yes | No |
| Their own subscriptions, invoices, the payment portal, cancel and resume | Yes (for any customer) | Yes, their own only |
| Refunds, complimentary plans, moving a subscription by hand | Yes | No |

Customers never see another customer's data, and the payment provider's secret keys never reach a browser. Money actions by administrators are recorded in the [audit log](/panel/audit).

## Per server: collaborators

An owner (or an administrator) can invite another customer to one server and choose the rights: view, console, files, backups, manage. A collaborator can use the owner's server within those rights but never counts toward their limits, cannot see the owner's other servers and cannot invite others unless **May share servers** is on for the **owner**.

## When something seems wrong

| Symptom | Look at |
| --- | --- |
| No **New server** button | The panel mode (above), then Customers → Edit limits for **May create servers** |
| The button shows but creating fails with a limit message | Edit limits → "what applies now" for the named limit |
| "Confirm your email address" | The customer signed up themselves and has not confirmed; see [Sign-up](/panel/signup) |
| Customer cannot delete a server | A subscription server (cancel the subscription), deleting turned off, or **May delete their own servers** is No |
| A customer lost a right after a payment problem | The account plan that gave it is suspended or ended; see [Billing and subscriptions](/panel/billing) |

## Suspended accounts

Account suspension overrides customer and collaborator grants. Billing, permitted account deletion, data export, security and the linked appeal remain available. Server operations, purchases and API tokens are refused. Backup download is opt-in for each suspension. See [Suspension](/panel/suspension) and the separate [administrator catalogue](/reference/permissions).

**May open support tickets** and **New tickets per day** are available in the layered limits editor. These do not disable suspension appeals.

| Action | Active customer | Suspended customer |
| --- | --- | --- |
| Server controls, console, files and SFTP | Within server grants | Refused |
| Buying and plan changes | Within store rules | Refused |
| Own invoices, paying, cancel and resume | Yes | Yes |
| Password, authenticator, passkeys and devices | Yes | Yes |
| Data export | When enabled | Always |
| Account deletion | Within account settings | Per suspension option |
| Backup download | Within server grants | Per suspension option |
| General tickets and articles | When desk enabled | Refused |
| Linked suspension appeal | When applicable | When appeals enabled |
| API tokens | Within token scopes | Refused |
