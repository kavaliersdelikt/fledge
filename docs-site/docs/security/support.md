---
title: Support security and privacy
---

# Support security and privacy

Ticket access is checked on every request. Customers see only their requested tickets, or eligible server-manager tickets when explicitly enabled. Suspension appeals are separately tied to an open suspension. Abuse reports never grant the reported customer access to the reporter's identity or message.

Customer serializers enumerate allowed fields and exclude internal notes, private tags, deadlines, assignments and events. Server and billing context follows administrator grants. Messages use safe text/Markdown rendering.

## Attachments

Files are detected by content and restricted to raster images, UTF-8 text/logs, valid JSON, ZIP and PDF. SVG and HTML are refused. Files live in PostgreSQL and downloads recheck ticket access; unattached files and note attachments are unavailable to customers. Responses use attachment disposition, `nosniff` and a sandboxing content security policy. The file, ticket, message and daily-byte limits are enforced server-side. **There is no antivirus scan.** Downloaded archives and documents still need your normal endpoint protections.

## Diagnostics and email

Only the requester's own server can supply diagnostics. Approved metadata and the last available console lines are assembled by the server; known credential values and credential-shaped text are redacted. The customer sees a preview and opts in. Redaction cannot infer every secret someone might print without a recognisable key. Review the preview before sending.

Optional inbound email requires both a signed ticket token and a separately signed, timestamped bridge request. A matching sender email alone is insufficient. Replay IDs prevent duplicate messages. Outgoing mail keeps the normal retries and delivery log.

## Retention and deletion

Closed tickets default to two-year retention. At expiry, requester identity, subject, diagnostics, rating comments, message bodies and attachments are removed while aggregate status/timing/rating data remains. Suspension appeals remain tied to account history. Account data export includes requested tickets, public messages, attachments and customer-visible suspension records; it excludes notes and private events.

Account deletion anonymises requester identifiers and message authors. Ticket text may remain until the configured retention expires; explain that policy to your customers. Suspension history is retained for administrative accountability. Public abuse reports require bot protection, per-IP and global rate limits, and do not accept uploaded attachments.

See [setup](/operate/support-setup), [suspension](/panel/suspension) and [administrator access](/security/administrators).
