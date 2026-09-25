# Fledge Web (Beta)

Connected Next.js 15/React 19 panel. No mock data, fake API responses, or demo handlers. API failures are shown in context; successful mutations refetch their affected lists.

## Run

```sh
cd web
npm ci
NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev
```

Open `http://localhost:3000`. `NEXT_PUBLIC_API_URL` is the **browser-reachable** API origin without `/api`; defaults to `http://localhost:4000` for local development. Set it at **build time** in production (Next.js inlines public variables). Configure API `WEB_ORIGIN` to match the panel origin exactly. Both origins must be same-site for the backend's `SameSite=Strict` session cookie; serve behind HTTPS for production. The panel calls the backend directly with `credentials: 'include'`; there is no Next proxy. Use `npm run check` and `npm run build` to verify.

## Implemented screens

- First-admin bootstrap, login with optional TOTP, mandatory admin 2FA setup/confirmation, session-based role navigation, logout.
- Admin: live overview (15-second refresh); nodes (register, enrollment token shown once, placement draining, remove); customers (create, one-time password, disable/enable, password reset); paginated server list and capacity-aware server create; paginated audit activity; scoped API tokens (shown once/revoke); account details.
- Customer: own/shared server list and detail, account details. Detail has actions, last-observed-state warning when node disconnected, recent durable jobs (8-second polling), authenticated live WebSocket console with incremental log output and Docker CPU/RAM samples plus Minecraft RCON commands, directory listing/text editing/file upload/download/ZIP extraction/folder creation, backups/create/download/delete/retention/restore, schedules, collaborators and editable template variables. Admin detail additionally offers limits/name changes, suspend/unsuspend, reinstall and asynchronous deletion.
- Loading, empty and API error states; explicit confirmations for destructive operations. Responsive table overflow, mobile sidebar, keyboard-visible focus. English interface copy. Lists are refreshed rather than pretending to stream; search filters the current server page only.
- Public `/install` assistant generates a copyable source-checkout command for Windows PowerShell, macOS shells and Linux shells. Admin Nodes view has a one-time token connector for Linux/systemd and Windows through WSL2.

## Known limitations / assumptions

The panel build, TypeScript checks, and dashboard/login browser review passed in this local evaluation. The console uses PostgreSQL-backed cross-process interests and a short-lived event relay, verified by the API console protocol test on one instance; a two-instance failover/load drill remains outstanding. Browser uploads/downloads stream through object storage up to 1 GiB; the text editor remains capped at 1 MiB. SFTP credentials are requested per server and expire after 15 minutes; agents must enable `SFTP_LISTEN`, and the operator must publish/restrict the SSH port. Logical quotas guard management transfers and SFTP, not writes made directly by the game container. Backup retention and S3-compatible transfers are locally exercised; real AWS retention, game-specific consistency, hard filesystem quotas, automatic stateful failover, and scheduled game boot verification remain unvalidated. Scheduled archive verification extracts to scratch and does not launch the game. Windows Docker Desktop is supported here only for local Linux containers + WSL2 Linux agent evaluation; native Windows services and Windows containers remain unsupported.

The server detail response includes `effectivePermissions` (`view`, `console`, `files`, `backups`, `manage`) and includes startup `variables` only for an admin, owner, or manage collaborator. The panel uses those effective grants to show only permitted console, file, and backup sections; schedules, collaborator access, editable settings, server action controls, and backup restore require manage access. Owners and admins retain their explicit full-access semantics, and manage collaborators receive all collaborator-level grants and actions. Provider-admin-only limit changes, suspend/unsuspend, reinstall, and deletion controls remain admin-only; a view-only collaborator sees server metadata and recent jobs. The API remains the authority and independently enforces every operation. Templates provide `editableVariables`; the settings form uses those and leaves blank, previously unset values unchanged rather than overriding template defaults. Browser password resets generate and display a random password client-side, because the PATCH API does not return a new secret. Activity and schedule rows retain backend snake_case fields. The admin bootstrap route is only successful on a fresh database; a 409 means use login.

Do not expose bootstrap publicly before initializing the admin. Provider 2FA credentials and agent enrollment tokens are sensitive; transfer them securely. Existing containers may continue running while the control plane is unavailable, but this panel cannot manage them until it returns. See `../api/README.md` for operational and security gaps before use with paying customers.

