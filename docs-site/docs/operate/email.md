---
title: Email
---

# Email

Email is optional. It powers:

- **invitations** for new customers and collaborators,
- **password reset** links,
- the **email** notification channel.

Without email, invitations return a link you can pass on yourself and password resets are done by an administrator.

## Configure

**Settings → Panel → Email**:

| Field | Meaning |
| --- | --- |
| Host, port | Your SMTP server. Port 587 with *STARTTLS* is typical; 465 with *TLS*. |
| Security | `none`, `starttls` or `tls` |
| Username, password | Optional. The password is stored encrypted. |
| From | `admin@example.com` or `Fledge <admin@example.com>` |

Use **Send test email** to verify. The same values can seed the form from `.env` (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`); once saved in the panel, the database wins.

## Behaviour

- Reset links work **once** and expire after an hour; invitation links work once and expire after 7 days.
- Asking for a reset always answers "ok", whether or not the address exists, so addresses cannot be probed.
- An administrator who resets their password still needs their authenticator.
- A password reset signs the account out everywhere and revokes its API tokens.
