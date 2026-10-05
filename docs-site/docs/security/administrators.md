---
title: Administrator security
---

# Administrator security

Administrator access combines mandatory two-factor authentication with live permission grants. The super administrator owns team management; that grant cannot be delegated. New installations promote the bootstrap account. Upgrade promotes the oldest active, unblocked administrator and retains full access for existing administrators.

Every administrative route is checked against a central permission policy. Unknown administrative paths fail closed. Requests read current grants from the database, so an old session cannot retain removed privileges. API tokens must satisfy both their narrow scopes and the owner's current grants. Explicit bearer authentication does not inherit browser-cookie privileges.

Customer security changes, deletion, refunds, team mutations and security settings require recent browser authentication. A successful authenticator sign-in is fresh for ten minutes. Otherwise the panel requests a new code, with the existing MFA attempt limit. Super administrator transfer additionally requires the sender's password and acceptance by the authenticated receiver through email.

Removing administrators revokes sessions, API tokens, SFTP credentials and invitation links. Open console connections recheck authorisation periodically. Already-running node jobs cannot be recalled by removing a grant; subsequent claims and requests use the updated state.

The database enforces at most one active super administrator. The bootstrap, migration, transfer and shell recovery paths ensure one exists after their transactions. Shell and database access remain privileged recovery capabilities. They are not restricted by panel permissions.

See [Team](/panel/team), [grants](/reference/permissions) and the [general threat model](/security/).
