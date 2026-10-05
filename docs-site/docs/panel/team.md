---
title: Team and permissions
---

# Team and permissions

The first administrator is the **super administrator**. The Team page is available only to that person. Every other administrator has an editable set of grants.

![Team permission editor](/screenshots/team.webp){.screenshot}

## Invite and delegate

Choose **Invite administrator**, enter an email and pick a preset. The invitation is single-use and expires after seven days. If email is unavailable, the invitation link is shown once. The receiver chooses their own password and must enable two-factor authentication before operating the panel.

A customer can become an administrator only when the account owns nothing. Select an administrator to inspect their grants. Presets fill the switches; they do not prevent individual changes. Save with a fresh authenticator code when prompted. Changes apply to already-open sessions on the next request. Navigation refreshes within a minute.

Removing an administrator blocks sign-in and revokes their sessions, tokens and outstanding invitation links. The super administrator cannot be removed, or delegate `team.manage`.

## Transfer the role

Choose an active administrator with two-factor authentication, then **Transfer super administrator role**. Confirm your password and recent authentication. The receiver receives a one-hour email link and must sign in as themselves and confirm recent authentication. Acceptance promotes the receiver and makes the previous super administrator a full Administrator. There remains one super administrator. Email delivery must be configured for this flow.

## Recovery from the server

Use the recovery script only with shell access to the panel's configured database and encryption environment. It accepts the email of an existing active administrator; it cannot create an administrator or promote a customer.

```sh
cd api
node --import tsx scripts/promote-super.mjs administrator@example.com
```

The transaction locks the team, replaces the old super administrator and writes an audit entry. Back up the database before operational recovery. See the [permission catalogue](/reference/permissions) and [administrator security model](/security/administrators).
