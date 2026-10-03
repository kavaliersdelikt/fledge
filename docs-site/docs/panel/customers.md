---
title: Customers and quotas
---

# Customers and quotas

**Customers** (administrators) manages accounts that own servers.

![The Customers page](/screenshots/customers.webp){.screenshot}

## Creating customers

**New customer**: an email address and, optionally, a password. If you leave the password empty, Fledge shows a
**temporary password once**. With [email](/operate/email) configured you can instead send an **invitation** link (valid
7 days) so the customer sets their own password.

Other actions: reset the password (the customer is signed out everywhere and their API tokens are revoked), **sign out
everywhere**, disable or enable the account.

## Quotas

A quota limits what a customer **owns**:

| Field | Limit on |
| --- | --- |
| `maxServers` | Number of servers |
| `maxMemoryMb` | Total reserved memory |
| `maxCpuPercent` | Total reserved CPU |
| `maxDiskMb` | Total reserved disk |
| `maxBackups` | Stored backups across their servers |
| `maxExtraPorts` | Extra ports across their servers |

A missing or empty field means *no limit*. Quotas are enforced when creating, resizing, backing up, adding ports and
[cloning](/panel/clone). The check runs inside the same transaction as the change, so two simultaneous creates cannot
both slip under the limit. Errors name what would be exceeded ("2048 MB memory in use, 512 requested").

Administrators can exceed a quota deliberately (the request's `force` option); customers cannot.

Customers see their own quota and usage (`GET /api/account/usage`), including remaining extra ports, in the panel.

## Collaborators

A customer (or an administrator) can invite another customer to a single server with chosen permissions on the server's
**Access** tab. Collaborators need an existing customer account.
