---
title: Adding an API route
---

# Adding an API route

1. **Write the handler** in the module that owns the area (or a new module) as a function that takes the Fastify `app`:

   ```ts
   export function pingRoutes(app: FastifyInstance) {
     app.get('/api/servers/:id/ping', async (req) => {
       const s = await serverAccess(req, (req.params as any).id, 'view'); // 404 for strangers, permission check
       return { ok: true, serverId: s.id };
     });
   }
   ```

   - Use `serverAccess(req, id, permission)` for anything about a server; `admin(req)` for administrator-only routes;
     `scope(req, 'read')` where an API token may reach the route.
   - Validate input with the helpers in `core.ts` (`txt`, `positive`, `asId`) and throw with `fail(status, message)`.
   - Mutations that need a node enqueue a **job** (`enqueue(...)`) and return `{ jobId, state }`.
   - Write an audit entry for anything that changes state: `await audit(req.actor!.id, 'thing.action', 'server', id, {…})`.

2. **Register it** next to the others in `api/src/index.ts`.

3. **Document it**: add an entry to the `docs` table in `api/src/openapi.ts`:

   ```ts
   'GET /api/servers/:id/ping': D('Servers', 'Check that a server is reachable', 'session', { scope: 'read' }),
   ```

   Routes are captured automatically (so they appear even without an entry, as *Undocumented*); the entry adds the summary,
   access level and body description. A token scope is only shown when the endpoint is in the token allow-list in `core.ts`.

4. **Test it** in the suite closest to the area (`api/test/*-smoke.mjs`) using the harness, covering the unhappy paths and who may
   not call it.

5. **Rebuild the reference**: `cd docs-site && npm run snapshot && npm run generate`.

## Adding a database column or table

Edit `db/schema.sql` additively and idempotently:

```sql
CREATE TABLE IF NOT EXISTS widgets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
ALTER TABLE servers ADD COLUMN IF NOT EXISTS widget_id uuid;
```

The [schema reference](/reference/schema) is generated from this file.

## Adding a plugin hook

Add the name to `KNOWN_HOOKS` in `api/src/plugins/manifest.ts`, call `emitHook('your.hook', {…})` where it happens, and document
the payload on [Hooks](/plugins/hooks).

## Adding a notification event

Add it to `EVENTS` in `api/src/notifications.ts` and call `emit({ kind, title, … })`. The [events reference](/reference/events) updates itself.

## Adding an agent job

Handle the kind in the `switch j.Kind` in `agent/main.go` and describe it in `docs-site/scripts/job-descriptions.json`; the docs build
fails when they disagree.
