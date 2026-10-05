CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','customer')), disabled boolean NOT NULL DEFAULT false,
 totp_secret text, totp_pending text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
-- Shared login throttling survives API restarts and works across replicas.
CREATE TABLE IF NOT EXISTS login_attempts (bucket_hash text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_expiry_idx ON login_attempts(expires_at);
CREATE TABLE IF NOT EXISTS api_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL, token_hash text NOT NULL UNIQUE, scopes text[] NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS nodes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, location text NOT NULL,
 status text NOT NULL DEFAULT 'disconnected', last_seen_at timestamptz,
 draining boolean NOT NULL DEFAULT false, headroom_mb integer NOT NULL DEFAULT 512,
 memory_mb integer NOT NULL, cpu_percent integer NOT NULL, disk_mb integer NOT NULL,
 version text, usage jsonb NOT NULL DEFAULT '{}'::jsonb, deleted_at timestamptz, credential_hash text,
 enrollment_hash text, enrollment_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(memory_mb>0 AND cpu_percent>0 AND disk_mb>0 AND headroom_mb>=0)
);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS templates (
 id text PRIMARY KEY, name text NOT NULL, image text NOT NULL, startup text,
 internal_ports jsonb NOT NULL, env jsonb NOT NULL DEFAULT '{}'::jsonb,
 memory_mb integer NOT NULL DEFAULT 2048, cpu_percent integer NOT NULL DEFAULT 100, disk_mb integer NOT NULL DEFAULT 10240,
 editable_variables text[] NOT NULL DEFAULT '{}', official boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS editable_variables text[] NOT NULL DEFAULT '{}';
INSERT INTO templates(id,name,image,internal_ports,env,memory_mb,cpu_percent,disk_mb,editable_variables,official) VALUES
 ('minecraft-java','Minecraft Java','itzg/minecraft-server:java21-alpine','[{"container":25565,"offset":0,"protocol":"tcp"}]'::jsonb,'{"EULA":"TRUE","TYPE":"VANILLA","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}'::jsonb,2048,100,10240,ARRAY['TYPE','VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true),
 ('valheim','Valheim','ghcr.io/lloesche/valheim-server:latest','[{"container":2456,"offset":0,"protocol":"udp"},{"container":2457,"offset":1,"protocol":"udp"},{"container":2458,"offset":2,"protocol":"udp"}]'::jsonb,'{"SERVER_NAME":"Fledge Server","WORLD_NAME":"Dedicated"}'::jsonb,4096,200,20480,ARRAY['SERVER_NAME','WORLD_NAME','SERVER_PASS','PUBLIC'],true)
ON CONFLICT(id) DO NOTHING;
UPDATE templates SET image='itzg/minecraft-server:java21-alpine', editable_variables=ARRAY['TYPE','VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'], env=env||'{"VERSION":"1.21.11","ENABLE_RCON":"TRUE"}'::jsonb WHERE id='minecraft-java' AND official;
UPDATE templates SET editable_variables=ARRAY['SERVER_NAME','WORLD_NAME','SERVER_PASS','PUBLIC'] WHERE id='valheim' AND official AND editable_variables='{}';
UPDATE templates SET env=env||'{"SERVER_NAME":"Fledge Server"}'::jsonb WHERE id='valheim' AND official AND env->>'SERVER_NAME'='Fledge';
CREATE TABLE IF NOT EXISTS servers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 owner_id uuid NOT NULL REFERENCES users(id), node_id uuid NOT NULL REFERENCES nodes(id),
 template_id text NOT NULL REFERENCES templates(id), memory_mb integer NOT NULL, cpu_percent integer NOT NULL, disk_mb integer NOT NULL,
 port integer NOT NULL, desired_status text NOT NULL DEFAULT 'running', observed_status text NOT NULL DEFAULT 'unknown',
 suspended boolean NOT NULL DEFAULT false, deleted_at timestamptz, variables jsonb NOT NULL DEFAULT '{}'::jsonb,
 usage jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(memory_mb>0 AND cpu_percent>0 AND disk_mb>0 AND port BETWEEN 1 AND 65535)
);
-- Additive migration: zero disables automatic backup expiration. Kept on servers so
-- each owner/provider can set a policy without affecting other tenants.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS backup_retention_days integer NOT NULL DEFAULT 0;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='servers_backup_retention_days_check' AND conrelid='servers'::regclass) THEN
  ALTER TABLE servers ADD CONSTRAINT servers_backup_retention_days_check CHECK (backup_retention_days BETWEEN 0 AND 3650);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS servers_owner_idx ON servers(owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS servers_node_idx ON servers(node_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS allocations (
 node_id uuid NOT NULL REFERENCES nodes(id), server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 port integer NOT NULL CHECK(port BETWEEN 1 AND 65535), protocol text NOT NULL CHECK(protocol IN ('tcp','udp')),
 PRIMARY KEY(node_id,port,protocol), UNIQUE(server_id,port,protocol)
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), node_id uuid NOT NULL REFERENCES nodes(id), server_id uuid REFERENCES servers(id),
 kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
 result jsonb, error text, attempt integer NOT NULL DEFAULT 0, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_pick_idx ON jobs(node_id,state,created_at);
CREATE INDEX IF NOT EXISTS jobs_server_pending_idx ON jobs(server_id,created_at,id) WHERE server_id IS NOT NULL AND state IN ('queued','running');
CREATE TABLE IF NOT EXISTS backups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid NOT NULL REFERENCES servers(id), job_id uuid UNIQUE REFERENCES jobs(id),
 object_key text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'queued', size_bytes bigint, error text,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS collaborators (
 server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 permissions text[] NOT NULL, PRIMARY KEY(server_id,user_id)
);
CREATE TABLE IF NOT EXISTS schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('backup','command')), command text, interval_minutes integer NOT NULL CHECK(interval_minutes>=5),
 next_run_at timestamptz NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
 id bigserial PRIMARY KEY, actor_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL, target_type text NOT NULL,
 target_id text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_recent_idx ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS auth_challenges (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry ON auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS request_limits(bucket_hash text PRIMARY KEY, attempts integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL);
INSERT INTO templates(id,name,image,internal_ports,env,memory_mb,cpu_percent,disk_mb,editable_variables,official) VALUES
('minecraft-paper','Minecraft Paper','itzg/minecraft-server:java21-alpine','[{"container":25565,"offset":0,"protocol":"tcp"}]','{"EULA":"TRUE","TYPE":"PAPER","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}',2048,100,10240,ARRAY['VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true),
('minecraft-fabric','Minecraft Fabric','itzg/minecraft-server:java21-alpine','[{"container":25565,"offset":0,"protocol":"tcp"}]','{"EULA":"TRUE","TYPE":"FABRIC","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}',3072,150,15360,ARRAY['VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true)
ON CONFLICT(id) DO NOTHING;

-- A minimal import-friendly template matching the portable fields produced by
-- the Pterodactyl egg converter (Quilt uses the itzg image entrypoint).
INSERT INTO templates(id,name,image,internal_ports,env,memory_mb,cpu_percent,disk_mb,editable_variables,official) VALUES
('minecraft-quilt','Minecraft Quilt','itzg/minecraft-server:java21-alpine','[{"container":25565,"offset":0,"protocol":"tcp"}]','{"EULA":"TRUE","TYPE":"QUILT","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}',3072,150,15360,ARRAY['VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS file_transfers(
 id uuid PRIMARY KEY, server_id uuid NOT NULL REFERENCES servers(id), user_id uuid NOT NULL REFERENCES users(id),
 direction text NOT NULL CHECK(direction IN ('upload','download')), path text NOT NULL, size_bytes bigint,
 object_key text NOT NULL, state text NOT NULL DEFAULT 'pending', job_id uuid REFERENCES jobs(id),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '2 hours'
);
CREATE INDEX IF NOT EXISTS file_transfers_expiry ON file_transfers(expires_at);

CREATE TABLE IF NOT EXISTS sftp_tokens(token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),server_id uuid NOT NULL REFERENCES servers(id),expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS sftp_tokens_expiry ON sftp_tokens(expires_at);

CREATE TABLE IF NOT EXISTS recovery_codes(user_id uuid NOT NULL REFERENCES users(id),code_hash text PRIMARY KEY);

CREATE TABLE IF NOT EXISTS console_events(id bigserial PRIMARY KEY,server_id uuid NOT NULL REFERENCES servers(id),frame jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS console_events_server ON console_events(server_id,id);
CREATE INDEX IF NOT EXISTS console_events_time ON console_events(created_at);
CREATE TABLE IF NOT EXISTS console_interests(replica uuid NOT NULL,server_id uuid NOT NULL REFERENCES servers(id),expires_at timestamptz NOT NULL,PRIMARY KEY(replica,server_id));
CREATE TABLE IF NOT EXISTS console_nodes(node_id uuid PRIMARY KEY REFERENCES nodes(id),replica uuid NOT NULL,expires_at timestamptz NOT NULL);

ALTER TABLE servers ADD COLUMN IF NOT EXISTS verify_interval_hours integer NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS verify_last_run timestamptz;

-- 0.5.1.1: panel-managed settings (secrets AES-GCM encrypted with ENCRYPTION_KEY).
CREATE TABLE IF NOT EXISTS settings(key text PRIMARY KEY,value jsonb NOT NULL DEFAULT '{}'::jsonb,secret text,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,updated_at timestamptz NOT NULL DEFAULT now());
-- Transfers spool on the API host when object storage is off.
ALTER TABLE file_transfers ADD COLUMN IF NOT EXISTS store text NOT NULL DEFAULT 's3';
-- What the agent reports about itself (platform, quota support, SFTP, updatability).
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS agent jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Address players and SFTP clients use to reach the node.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS public_host text;
CREATE INDEX IF NOT EXISTS jobs_agent_update_idx ON jobs(node_id,created_at) WHERE kind='agent.update';

-- 0.5.1.1: graceful stop command (Pterodactyl egg stop). '^C' means SIGINT.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS stop_command text;

-- 0.5.2.1: automatic failover, planned migration and node health history.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS failover_enabled boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS failover_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('failover','migration')),
 state text NOT NULL CHECK(state IN ('blocked','backing-up','restoring','completed','failed')),
 reason text NOT NULL DEFAULT '', from_node uuid REFERENCES nodes(id), to_node uuid REFERENCES nodes(id),
 backup_id uuid REFERENCES backups(id) ON DELETE SET NULL, data_age_seconds integer, error text,
 job_id uuid, actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 started_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS failover_events_recent ON failover_events(started_at DESC);
CREATE INDEX IF NOT EXISTS failover_events_server ON failover_events(server_id,started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS failover_events_one_open ON failover_events(server_id) WHERE state IN ('blocked','backing-up','restoring');
CREATE TABLE IF NOT EXISTS node_events(
 id bigserial PRIMARY KEY, node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('down','up')), at timestamptz NOT NULL DEFAULT now(), detail text
);
CREATE INDEX IF NOT EXISTS node_events_recent ON node_events(at DESC);

-- 0.5.2.3: more preinstalled templates. Each is seeded once (ON CONFLICT DO
-- NOTHING), so edits made in the panel are kept. Runtime templates run the
-- startup command through /bin/sh with the server data mounted at /data;
-- install scripts are not used, so upload your code and it is installed on start.
INSERT INTO templates(id,name,image,startup,stop_command,internal_ports,env,memory_mb,cpu_percent,disk_mb,editable_variables,official) VALUES
('minecraft-purpur','Minecraft Purpur','itzg/minecraft-server:java21-alpine',NULL,NULL,'[{"container":25565,"offset":0,"protocol":"tcp"}]','{"EULA":"TRUE","TYPE":"PURPUR","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}',2048,100,10240,ARRAY['VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true),
('minecraft-folia','Minecraft Folia','itzg/minecraft-server:java21-alpine',NULL,NULL,'[{"container":25565,"offset":0,"protocol":"tcp"}]','{"EULA":"TRUE","TYPE":"FOLIA","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}',3072,200,15360,ARRAY['VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true),
('minecraft-spigot','Minecraft Spigot','itzg/minecraft-server:java21-alpine',NULL,NULL,'[{"container":25565,"offset":0,"protocol":"tcp"}]','{"EULA":"TRUE","TYPE":"SPIGOT","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}',2048,100,10240,ARRAY['VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true),
('minecraft-forge','Minecraft Forge','itzg/minecraft-server:java21-alpine',NULL,NULL,'[{"container":25565,"offset":0,"protocol":"tcp"}]','{"EULA":"TRUE","TYPE":"FORGE","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}',4096,200,20480,ARRAY['VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true),
('minecraft-neoforge','Minecraft NeoForge','itzg/minecraft-server:java21-alpine',NULL,NULL,'[{"container":25565,"offset":0,"protocol":"tcp"}]','{"EULA":"TRUE","TYPE":"NEOFORGE","VERSION":"1.21.11","ENABLE_RCON":"TRUE"}',4096,200,20480,ARRAY['VERSION','DIFFICULTY','MAX_PLAYERS','MOTD'],true),
('minecraft-bedrock','Minecraft Bedrock','itzg/minecraft-bedrock-server:latest',NULL,NULL,'[{"container":19132,"offset":0,"protocol":"udp"}]','{"EULA":"TRUE","SERVER_NAME":"Fledge Server","GAMEMODE":"survival","DIFFICULTY":"easy","MAX_PLAYERS":"10"}',1024,100,10240,ARRAY['SERVER_NAME','GAMEMODE','DIFFICULTY','MAX_PLAYERS'],true),
('nodejs','Node.js','node:22-slim','cd /data && if [ "$INSTALL_DEPS" = 1 ] && [ -f package.json ]; then npm install --omit=dev --no-audit --no-fund || exit 1; fi; exec node "$MAIN_FILE"','^C','[{"container":3000,"offset":0,"protocol":"tcp"}]','{"MAIN_FILE":"index.js","INSTALL_DEPS":"1","NODE_ENV":"production","PORT":"3000"}',512,100,5120,ARRAY['MAIN_FILE','INSTALL_DEPS','NODE_ENV'],true),
('python','Python','python:3.13-slim','cd /data && if [ -f "$REQUIREMENTS_FILE" ]; then pip install --no-cache-dir --disable-pip-version-check --target /data/.pydeps -r "$REQUIREMENTS_FILE" || exit 1; fi; exec python "$MAIN_FILE"','^C','[{"container":8080,"offset":0,"protocol":"tcp"}]','{"MAIN_FILE":"main.py","REQUIREMENTS_FILE":"requirements.txt","PYTHONUNBUFFERED":"1","PYTHONPATH":"/data/.pydeps","PORT":"8080"}',512,100,5120,ARRAY['MAIN_FILE','REQUIREMENTS_FILE'],true),
('bun','Bun','oven/bun:1','cd /data && if [ "$INSTALL_DEPS" = 1 ] && [ -f package.json ]; then bun install --production || exit 1; fi; exec bun run "$MAIN_FILE"','^C','[{"container":3000,"offset":0,"protocol":"tcp"}]','{"MAIN_FILE":"index.ts","INSTALL_DEPS":"1","NODE_ENV":"production","PORT":"3000"}',512,100,5120,ARRAY['MAIN_FILE','INSTALL_DEPS','NODE_ENV'],true),
('golang','Go','golang:1.24','cd /data && exec go run "$MAIN_PACKAGE"','^C','[{"container":8080,"offset":0,"protocol":"tcp"}]','{"MAIN_PACKAGE":".","GOFLAGS":"-buildvcs=false","PORT":"8080"}',1024,100,5120,ARRAY['MAIN_PACKAGE'],true),
('java','Java (JAR)','eclipse-temurin:21-jre','cd /data && exec java -Xms128M -Xmx$((SERVER_MEMORY*85/100))M $JAVA_ARGS -jar "$SERVER_JARFILE"','^C','[{"container":8080,"offset":0,"protocol":"tcp"}]','{"SERVER_JARFILE":"server.jar","JAVA_ARGS":""}',1024,100,5120,ARRAY['SERVER_JARFILE','JAVA_ARGS'],true),
('dotnet','.NET','mcr.microsoft.com/dotnet/aspnet:9.0','cd /data && exec dotnet "$APP_DLL"','^C','[{"container":8080,"offset":0,"protocol":"tcp"}]','{"APP_DLL":"app.dll","ASPNETCORE_URLS":"http://0.0.0.0:8080","DOTNET_EnableDiagnostics":"0"}',1024,100,5120,ARRAY['APP_DLL'],true),
('php','PHP','php:8.4-cli','cd /data && exec php -S 0.0.0.0:8080 -t "$DOCUMENT_ROOT"','^C','[{"container":8080,"offset":0,"protocol":"tcp"}]','{"DOCUMENT_ROOT":"."}',512,100,5120,ARRAY['DOCUMENT_ROOT'],true),
('ruby','Ruby','ruby:3.4-slim','cd /data && if [ -f Gemfile ]; then bundle install || exit 1; fi; exec ruby "$MAIN_FILE"','^C','[{"container":3000,"offset":0,"protocol":"tcp"}]','{"MAIN_FILE":"main.rb","PORT":"3000"}',512,100,5120,ARRAY['MAIN_FILE'],true)
ON CONFLICT(id) DO NOTHING;

-- ===========================================================================
-- 0.6.1.1 "Roost": plugins, add-ons and the features around them.
-- Everything below is additive and safe to run repeatedly.
-- ===========================================================================

-- Installed plugins. Code lives here (not on disk) so every API replica sees the same
-- version; the plugin host receives it per call and caches it by checksum.
CREATE TABLE IF NOT EXISTS plugins(
 id text PRIMARY KEY CHECK(id ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
 name text NOT NULL, version text NOT NULL,
 tier text NOT NULL CHECK(tier IN ('bundled','verified','community')),
 source text NOT NULL, manifest jsonb NOT NULL, code text NOT NULL, code_sha256 text NOT NULL, package_sha256 text,
 icon text, readme text, changelog text,
 enabled boolean NOT NULL DEFAULT false,
 granted_permissions text[] NOT NULL DEFAULT '{}',
 settings jsonb NOT NULL DEFAULT '{}'::jsonb, secrets text,
 previous jsonb,
 failure_count integer NOT NULL DEFAULT 0, last_error text, disabled_reason text,
 installed_by uuid REFERENCES users(id) ON DELETE SET NULL,
 installed_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plugin_kv(
 plugin_id text NOT NULL REFERENCES plugins(id) ON DELETE CASCADE, key text NOT NULL, value jsonb NOT NULL,
 PRIMARY KEY(plugin_id,key)
);
CREATE TABLE IF NOT EXISTS plugin_logs(
 id bigserial PRIMARY KEY, plugin_id text NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
 level text NOT NULL, message text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plugin_logs_recent ON plugin_logs(plugin_id,id DESC);

-- What kind of add-ons a template supports (see api/src/addons.ts). NULL means none.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS addons jsonb;
UPDATE templates SET addons='{"versionVar":"VERSION","typeVar":"TYPE","types":{"PAPER":{"kind":"plugin","dir":"/plugins","loaders":["paper","spigot","bukkit"]},"PURPUR":{"kind":"plugin","dir":"/plugins","loaders":["purpur","paper","spigot","bukkit"]},"FOLIA":{"kind":"plugin","dir":"/plugins","loaders":["folia"]},"SPIGOT":{"kind":"plugin","dir":"/plugins","loaders":["spigot","bukkit"]},"BUKKIT":{"kind":"plugin","dir":"/plugins","loaders":["bukkit"]},"PUFFERFISH":{"kind":"plugin","dir":"/plugins","loaders":["paper","spigot","bukkit"]},"FABRIC":{"kind":"mod","dir":"/mods","loaders":["fabric"]},"QUILT":{"kind":"mod","dir":"/mods","loaders":["quilt","fabric"]},"FORGE":{"kind":"mod","dir":"/mods","loaders":["forge"]},"NEOFORGE":{"kind":"mod","dir":"/mods","loaders":["neoforge"]}}}'::jsonb
 WHERE addons IS NULL AND official AND id IN ('minecraft-java','minecraft-paper','minecraft-purpur','minecraft-folia','minecraft-spigot','minecraft-fabric','minecraft-quilt','minecraft-forge','minecraft-neoforge');

-- Files that plugins installed into servers (mods and plugins), tracked so they can be
-- updated, disabled and removed. `plugin_id` is not a foreign key on purpose: removing a
-- catalog plugin leaves the installed files and their records in place.
CREATE TABLE IF NOT EXISTS server_addons(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 plugin_id text NOT NULL, provider text NOT NULL DEFAULT '', kind text NOT NULL, dir text NOT NULL,
 project_id text NOT NULL, project_title text NOT NULL, project_slug text, icon_url text,
 version_id text NOT NULL, version_label text NOT NULL DEFAULT '', filename text NOT NULL,
 sha512 text, size_bytes bigint, source_url text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','installed','failed','removing')),
 disabled boolean NOT NULL DEFAULT false, pinned boolean NOT NULL DEFAULT false,
 is_dependency boolean NOT NULL DEFAULT false, error text, job_id uuid,
 installed_by uuid REFERENCES users(id) ON DELETE SET NULL,
 installed_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS server_addons_server ON server_addons(server_id,state);
CREATE UNIQUE INDEX IF NOT EXISTS server_addons_project ON server_addons(server_id,plugin_id,project_id) WHERE state<>'failed';

-- Template v2: typed variables, descriptions, versions and a history for "update servers".
ALTER TABLE templates ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS variables jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS quick_commands jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE servers ADD COLUMN IF NOT EXISTS template_version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS template_versions(
 template_id text NOT NULL REFERENCES templates(id) ON DELETE CASCADE, version integer NOT NULL,
 snapshot jsonb NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(template_id,version)
);
-- Every template gets its version-1 snapshot, so later versions can be compared against it.
INSERT INTO template_versions(template_id,version,snapshot)
 SELECT id,version,jsonb_build_object('image',image,'startup',startup,'stopCommand',stop_command,'internalPorts',internal_ports,'env',env)
 FROM templates ON CONFLICT DO NOTHING;
-- Typed variable definitions for the preinstalled templates (only where none were set yet).
UPDATE templates SET variables='[{"key":"TYPE","label":"Server software","type":"select","options":[{"value":"VANILLA","label":"Vanilla"},{"value":"PAPER","label":"Paper"},{"value":"PURPUR","label":"Purpur"},{"value":"FOLIA","label":"Folia"},{"value":"SPIGOT","label":"Spigot"},{"value":"FABRIC","label":"Fabric"},{"value":"QUILT","label":"Quilt"},{"value":"FORGE","label":"Forge"},{"value":"NEOFORGE","label":"NeoForge"}],"description":"Which server software to run. Changing it recreates the server.","userEditable":true},{"key":"VERSION","label":"Minecraft version","type":"string","pattern":"^(LATEST|SNAPSHOT|\\d+(\\.\\d+){1,3}[-\\w.]*)$","description":"For example 1.21.11, or LATEST.","userEditable":true},{"key":"DIFFICULTY","label":"Difficulty","type":"select","options":[{"value":"peaceful","label":"Peaceful"},{"value":"easy","label":"Easy"},{"value":"normal","label":"Normal"},{"value":"hard","label":"Hard"}],"userEditable":true},{"key":"MAX_PLAYERS","label":"Maximum players","type":"number","min":1,"max":1000,"userEditable":true},{"key":"MOTD","label":"Message of the day","type":"string","userEditable":true}]'::jsonb
 WHERE id='minecraft-java' AND variables='[]'::jsonb;
UPDATE templates SET variables='[{"key":"VERSION","label":"Minecraft version","type":"string","pattern":"^(LATEST|SNAPSHOT|\\d+(\\.\\d+){1,3}[-\\w.]*)$","description":"For example 1.21.11, or LATEST.","userEditable":true},{"key":"DIFFICULTY","label":"Difficulty","type":"select","options":[{"value":"peaceful","label":"Peaceful"},{"value":"easy","label":"Easy"},{"value":"normal","label":"Normal"},{"value":"hard","label":"Hard"}],"userEditable":true},{"key":"MAX_PLAYERS","label":"Maximum players","type":"number","min":1,"max":1000,"userEditable":true},{"key":"MOTD","label":"Message of the day","type":"string","userEditable":true}]'::jsonb
 WHERE id IN ('minecraft-paper','minecraft-purpur','minecraft-folia','minecraft-spigot','minecraft-fabric','minecraft-quilt','minecraft-forge','minecraft-neoforge') AND variables='[]'::jsonb;
UPDATE templates SET variables='[{"key":"SERVER_NAME","label":"Server name","type":"string","description":"Shown in the server browser.","userEditable":true},{"key":"WORLD_NAME","label":"World name","type":"string","pattern":"^[A-Za-z0-9_ -]{1,40}$","userEditable":true},{"key":"SERVER_PASS","label":"Server password","type":"string","secret":true,"min":5,"description":"At least 5 characters.","userEditable":true},{"key":"PUBLIC","label":"List publicly","type":"select","options":[{"value":"1","label":"Yes"},{"value":"0","label":"No"}],"userEditable":true}]'::jsonb
 WHERE id='valheim' AND variables='[]'::jsonb;
UPDATE templates SET variables='[{"key":"SERVER_NAME","label":"Server name","type":"string","userEditable":true},{"key":"GAMEMODE","label":"Game mode","type":"select","options":[{"value":"survival","label":"Survival"},{"value":"creative","label":"Creative"},{"value":"adventure","label":"Adventure"}],"userEditable":true},{"key":"DIFFICULTY","label":"Difficulty","type":"select","options":[{"value":"peaceful","label":"Peaceful"},{"value":"easy","label":"Easy"},{"value":"normal","label":"Normal"},{"value":"hard","label":"Hard"}],"userEditable":true},{"key":"MAX_PLAYERS","label":"Maximum players","type":"number","min":1,"max":200,"userEditable":true}]'::jsonb
 WHERE id='minecraft-bedrock' AND variables='[]'::jsonb;
-- Handy console lines for Minecraft Java servers (shown as quick buttons; editable per template).
UPDATE templates SET quick_commands='[{"label":"Save world","command":"save-all"},{"label":"Who is online","command":"list"},{"label":"Say hello","command":"say Hello from the panel"}]'::jsonb
 WHERE image LIKE 'itzg/minecraft-server:%' AND quick_commands='[]'::jsonb;

-- Per-customer limits ({} = unlimited) and extra port mappings per server (offsets from the
-- server's base port, like the template's own ports).
ALTER TABLE users ADD COLUMN IF NOT EXISTS quota jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS extra_ports jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ===========================================================================
-- Autopilot: schedules with cron and task chains, crash policy, notification center.
-- ===========================================================================
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS cron text;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS tasks jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS missed text NOT NULL DEFAULT 'skip';
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_status text;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_kind_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_kind_check CHECK(kind IN ('backup','command','chain'));
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_interval_minutes_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_interval_minutes_check CHECK(interval_minutes>=0);
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_missed_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_missed_check CHECK(missed IN ('skip','run'));
CREATE TABLE IF NOT EXISTS schedule_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
 server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','succeeded','failed','skipped')),
 step integer NOT NULL DEFAULT 0, next_step_at timestamptz, results jsonb NOT NULL DEFAULT '[]'::jsonb, error text,
 trigger text NOT NULL DEFAULT 'schedule', started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS schedule_runs_due ON schedule_runs(next_step_at) WHERE state='running';
CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs(schedule_id,started_at DESC);
-- A schedule never has two runs in flight at once.
CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_one_running ON schedule_runs(schedule_id) WHERE state='running';

ALTER TABLE servers ADD COLUMN IF NOT EXISTS crash_policy jsonb NOT NULL DEFAULT '{"mode":"off"}'::jsonb;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS crash_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS last_exit jsonb;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS alert_state jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS server_events(
 id bigserial PRIMARY KEY, server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 kind text NOT NULL, message text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS server_events_recent ON server_events(server_id,id DESC);

CREATE TABLE IF NOT EXISTS notification_channels(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL CHECK(scope IN ('panel','user')),
 user_id uuid REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('webhook','discord','slack','email')),
 config jsonb NOT NULL DEFAULT '{}'::jsonb, secret text, events text[] NOT NULL DEFAULT '{}', server_ids uuid[],
 enabled boolean NOT NULL DEFAULT true, last_status text, last_error text, last_sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_channels_user ON notification_channels(user_id);
CREATE TABLE IF NOT EXISTS notifications(
 id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL, severity text NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warn','bad','ok')),
 title text NOT NULL, body text NOT NULL DEFAULT '', server_id uuid REFERENCES servers(id) ON DELETE SET NULL, node_id uuid,
 data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,id DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_seen_id bigint NOT NULL DEFAULT 0;

-- ===========================================================================
-- Account security: session details, one-time email links, passkeys.
-- ===========================================================================
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS user_tokens(
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('invite','reset')), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_tokens_user ON user_tokens(user_id,kind);
CREATE TABLE IF NOT EXISTS passkeys(
 id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 public_key bytea NOT NULL, counter bigint NOT NULL DEFAULT 0, transports text[] NOT NULL DEFAULT '{}',
 name text NOT NULL, device_type text, backed_up boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS webauthn_challenges(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind text NOT NULL, challenge text NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,kind)
);

-- Resource history per server: 1-minute buckets (24 h), 5-minute (7 days) and hourly (30 days).
CREATE TABLE IF NOT EXISTS server_metrics(
 server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE, res smallint NOT NULL CHECK(res IN (1,2,3)), bucket timestamptz NOT NULL,
 cpu_sum double precision NOT NULL DEFAULT 0, cpu_max real NOT NULL DEFAULT 0, mem_sum double precision NOT NULL DEFAULT 0, mem_max double precision NOT NULL DEFAULT 0,
 disk_bytes bigint, n integer NOT NULL DEFAULT 0, PRIMARY KEY(server_id,res,bucket)
);
CREATE INDEX IF NOT EXISTS server_metrics_age ON server_metrics(res,bucket);

-- 0.6.2.1 "Plumage": appearance. The document is the settings row "branding"; uploaded images and the last 20 versions live here.
CREATE TABLE IF NOT EXISTS branding_blobs(
 sha256 text NOT NULL, kind text NOT NULL, mime text NOT NULL, bytes bytea NOT NULL, width integer, height integer,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(sha256,kind)
);
CREATE TABLE IF NOT EXISTS branding_history(
 id bigserial PRIMARY KEY, revision integer NOT NULL, at timestamptz NOT NULL DEFAULT now(),
 by uuid REFERENCES users(id) ON DELETE SET NULL, reason text NOT NULL, value jsonb NOT NULL
);
-- A person's own light or dark choice follows their account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ===========================================================================
-- 0.7.1.1 "Rookery": sign-up, self-service servers, limits, plans, store, payments, email.
-- Everything here is additive and idempotent; nothing existing is rewritten.
-- ===========================================================================

-- Accounts that sign themselves up go through verification (and optionally approval) first.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK(status IN ('active','pending_verification','pending_approval','deletion_pending','suspended'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source text NOT NULL DEFAULT 'admin';
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_ip_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
CREATE INDEX IF NOT EXISTS users_status_idx ON users(status) WHERE status<>'active';
ALTER TABLE user_tokens DROP CONSTRAINT IF EXISTS user_tokens_kind_check;
ALTER TABLE user_tokens ADD CONSTRAINT user_tokens_kind_check CHECK(kind IN ('invite','reset','verify','email_change'));
ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Invite links and codes for invite-only sign-up.
CREATE TABLE IF NOT EXISTS signup_invites(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text NOT NULL UNIQUE, email text, note text,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL, expires_at timestamptz NOT NULL,
 max_uses integer NOT NULL DEFAULT 1 CHECK(max_uses BETWEEN 1 AND 10000), uses integer NOT NULL DEFAULT 0,
 plan_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);

-- Servers: who created them, what keeps them alive and why they are suspended.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS subscription_id uuid;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS suspended_reason text;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS created_via text NOT NULL DEFAULT 'admin';
ALTER TABLE servers ADD COLUMN IF NOT EXISTS pending_delete_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS servers_subscription_idx ON servers(subscription_id) WHERE subscription_id IS NOT NULL AND deleted_at IS NULL;
-- Templates are invisible to customers until an administrator says otherwise.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS customer_visible boolean NOT NULL DEFAULT false;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS customer_description text;

-- Plans: something that can be given or sold. A server plan carries a preset (one server per
-- subscription); an account plan carries an allowance added to the customer's limits.
CREATE TABLE IF NOT EXISTS plans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL, description text NOT NULL DEFAULT '',
 kind text NOT NULL CHECK(kind IN ('server','account')),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','private')),
 active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0,
 features jsonb NOT NULL DEFAULT '[]'::jsonb, preset jsonb NOT NULL DEFAULT '{}'::jsonb, limits jsonb NOT NULL DEFAULT '{}'::jsonb,
 options jsonb NOT NULL DEFAULT '{}'::jsonb,
 stock integer CHECK(stock IS NULL OR stock>=0), per_customer_max integer NOT NULL DEFAULT 1 CHECK(per_customer_max>=1),
 trial_once boolean NOT NULL DEFAULT true, retention_days integer CHECK(retention_days IS NULL OR retention_days BETWEEN 0 AND 3650),
 archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plan_prices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
 cycle text NOT NULL CHECK(cycle IN ('month','quarter','semiannual','year')),
 amount bigint NOT NULL CHECK(amount>=0), currency text NOT NULL CHECK(currency ~ '^[a-z]{3}$'),
 trial_days integer NOT NULL DEFAULT 0 CHECK(trial_days BETWEEN 0 AND 365), setup_fee bigint NOT NULL DEFAULT 0 CHECK(setup_fee>=0),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
-- One current price per plan, interval and currency; older prices stay for the subscriptions that use them.
CREATE UNIQUE INDEX IF NOT EXISTS plan_prices_current ON plan_prices(plan_id,cycle,currency) WHERE active;

-- A checkout attempt. The payment is matched to an order, never to what the browser says.
CREATE TABLE IF NOT EXISTS orders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), plan_id uuid NOT NULL REFERENCES plans(id),
 price_id uuid NOT NULL REFERENCES plan_prices(id),
 status text NOT NULL DEFAULT 'created' CHECK(status IN ('created','pending','paid','expired','failed','canceled')),
 snapshot jsonb NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 provider text NOT NULL, provider_session_id text, provider_customer_id text, livemode boolean NOT NULL DEFAULT false,
 terms_version text, subscription_id uuid, error text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS orders_session_idx ON orders(provider,provider_session_id) WHERE provider_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriptions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), plan_id uuid NOT NULL REFERENCES plans(id),
 price_id uuid REFERENCES plan_prices(id), order_id uuid REFERENCES orders(id),
 provider text NOT NULL, provider_subscription_id text, provider_customer_id text, livemode boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'incomplete' CHECK(status IN ('incomplete','trialing','active','past_due','suspended','canceled','terminated')),
 cancel_at_period_end boolean NOT NULL DEFAULT false,
 cycle text NOT NULL CHECK(cycle IN ('month','quarter','semiannual','year')), amount bigint NOT NULL DEFAULT 0 CHECK(amount>=0), currency text NOT NULL DEFAULT 'eur',
 current_period_start timestamptz, current_period_end timestamptz, trial_end timestamptz,
 past_due_since timestamptz, suspended_at timestamptz, canceled_at timestamptz, ended_at timestamptz, terminated_at timestamptz, retention_until timestamptz,
 manual_ends_at timestamptz, note text,
 fulfilment text NOT NULL DEFAULT 'none' CHECK(fulfilment IN ('none','pending','done','failed')),
 fulfilment_attempts integer NOT NULL DEFAULT 0, fulfilment_error text, next_fulfilment_at timestamptz,
 server_details jsonb NOT NULL DEFAULT '{}'::jsonb, dunning jsonb NOT NULL DEFAULT '{}'::jsonb, holds jsonb NOT NULL DEFAULT '[]'::jsonb,
 version integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_idx ON subscriptions(provider,provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status) WHERE status NOT IN ('canceled','terminated');
CREATE TABLE IF NOT EXISTS subscription_events(
 id bigserial PRIMARY KEY, subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, at timestamptz NOT NULL DEFAULT now(),
 from_status text, to_status text, reason text NOT NULL, source text NOT NULL, ref text, detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS subscription_events_sub ON subscription_events(subscription_id,id DESC);
-- Servers and plans may only point at rows that exist.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='servers_subscription_fk') THEN
  ALTER TABLE servers ADD CONSTRAINT servers_subscription_fk FOREIGN KEY(subscription_id) REFERENCES subscriptions(id);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS invoices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL, user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 provider text NOT NULL, provider_invoice_id text NOT NULL, number text, status text NOT NULL,
 amount_due bigint NOT NULL DEFAULT 0, amount_paid bigint NOT NULL DEFAULT 0, amount_refunded bigint NOT NULL DEFAULT 0, currency text NOT NULL,
 period_start timestamptz, period_end timestamptz, hosted_url text, pdf_url text, description text,
 livemode boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
 UNIQUE(provider,provider_invoice_id)
);
CREATE INDEX IF NOT EXISTS invoices_user_idx ON invoices(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_customers(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider text NOT NULL, livemode boolean NOT NULL DEFAULT false,
 provider_customer_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,provider,livemode)
);
-- The webhook inbox: stored first, acknowledged, processed with retries. Unique per provider event.
CREATE TABLE IF NOT EXISTS billing_events(
 id bigserial PRIMARY KEY, provider text NOT NULL, event_id text NOT NULL, type text NOT NULL, livemode boolean NOT NULL DEFAULT false,
 refs jsonb NOT NULL DEFAULT '{}'::jsonb, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), error text, UNIQUE(provider,event_id)
);
CREATE INDEX IF NOT EXISTS billing_events_pending ON billing_events(next_attempt_at) WHERE processed_at IS NULL;

-- Email: editable templates and a retrying outbox.
CREATE TABLE IF NOT EXISTS email_templates(
 id text PRIMARY KEY, subject text NOT NULL, text_body text NOT NULL, html_body text, enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS email_outbox(
 id bigserial PRIMARY KEY, to_addr text NOT NULL, template text NOT NULL, user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 subject text NOT NULL, text_body text, html_body text, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text, dedupe_key text,
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_dedupe ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(next_attempt_at) WHERE status IN ('queued','sending');
CREATE INDEX IF NOT EXISTS email_outbox_recent ON email_outbox(id DESC);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_url text;

-- Mews: administrator grants and explained account holds.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_permissions text[];
UPDATE users SET is_super=true WHERE id=(SELECT id FROM users WHERE role='admin' AND NOT disabled AND status='active' ORDER BY created_at,id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM users WHERE is_super);
CREATE UNIQUE INDEX IF NOT EXISTS users_one_super ON users(is_super) WHERE is_super;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='users_super_admin') THEN
  ALTER TABLE users ADD CONSTRAINT users_super_admin CHECK(NOT is_super OR (role='admin' AND NOT disabled AND status='active'));
 END IF;
END $$;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS stepped_up_at timestamptz;
CREATE TABLE IF NOT EXISTS account_suspensions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), reference text NOT NULL UNIQUE,
 reason text NOT NULL CHECK(reason IN ('billing','terms','security','review','requested','other')),
 source text NOT NULL DEFAULT 'admin' CHECK(source IN ('admin','billing','system','api')),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 2000), internal_note text NOT NULL DEFAULT '' CHECK(length(internal_note)<=2000),
 stop_servers boolean NOT NULL DEFAULT true, stopped_server_ids uuid[] NOT NULL DEFAULT '{}',
 allow_backup_download boolean NOT NULL DEFAULT false, allow_account_deletion boolean NOT NULL DEFAULT true,
 lift_on_payment boolean NOT NULL DEFAULT false, notify boolean NOT NULL DEFAULT true, until timestamptz,
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), lifted_at timestamptz,
 lifted_by uuid REFERENCES users(id), lift_note text, retention_notified_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS account_suspensions_open ON account_suspensions(user_id) WHERE lifted_at IS NULL;
CREATE TABLE IF NOT EXISTS account_suspension_events(
 id bigserial PRIMARY KEY, suspension_id uuid NOT NULL REFERENCES account_suspensions(id), kind text NOT NULL,
 actor uuid REFERENCES users(id), data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS team_transfers(
 token_hash text PRIMARY KEY, sender_id uuid NOT NULL REFERENCES users(id), receiver_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
-- Help desk data. Customer projections never select private fields or notes.
CREATE TABLE IF NOT EXISTS support_groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS support_group_members(group_id uuid REFERENCES support_groups(id) ON DELETE CASCADE,user_id uuid REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(group_id,user_id));
CREATE TABLE IF NOT EXISTS support_tiers(id text PRIMARY KEY,name text NOT NULL,first_reply_minutes integer NOT NULL CHECK(first_reply_minutes>0),solve_minutes integer NOT NULL CHECK(solve_minutes>0),warn_percent integer NOT NULL DEFAULT 80 CHECK(warn_percent BETWEEN 1 AND 100));
INSERT INTO support_tiers VALUES('standard','Standard',240,2880,80),('priority','Priority',60,1440,80),('urgent','Urgent',30,480,80) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS support_hours(id integer PRIMARY KEY DEFAULT 1 CHECK(id=1),timezone text NOT NULL DEFAULT 'UTC',weekly jsonb NOT NULL DEFAULT '{"1":[[540,1020]],"2":[[540,1020]],"3":[[540,1020]],"4":[[540,1020]],"5":[[540,1020]]}',holidays jsonb NOT NULL DEFAULT '[]');
INSERT INTO support_hours(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS support_categories(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL UNIQUE,group_id uuid REFERENCES support_groups(id),default_priority text NOT NULL DEFAULT 'normal',tier_id text REFERENCES support_tiers(id),public boolean NOT NULL DEFAULT true,sort integer NOT NULL DEFAULT 0);
INSERT INTO support_groups(name) VALUES('General'),('Abuse') ON CONFLICT DO NOTHING;
INSERT INTO support_categories(name,tier_id,public,sort) VALUES('Server help','standard',true,0),('Billing','standard',true,1),('Other','standard',true,2),('Suspension appeal','urgent',false,3),('Abuse','urgent',false,4) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS support_tickets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),number serial UNIQUE,requester_user_id uuid REFERENCES users(id) ON DELETE SET NULL,requester_email text NOT NULL,
 source text NOT NULL CHECK(source IN ('panel','email','abuse_form','api','suspension')),subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
 category_id uuid REFERENCES support_categories(id),priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending','hold','solved','closed')),
 assignee_id uuid REFERENCES users(id),group_id uuid REFERENCES support_groups(id),server_id uuid REFERENCES servers(id),subscription_id uuid REFERENCES subscriptions(id),suspension_id uuid REFERENCES account_suspensions(id),
 tier_id text REFERENCES support_tiers(id),first_reply_due_at timestamptz,solve_due_at timestamptz,first_reply_at timestamptz,solved_at timestamptz,closed_at timestamptz,reopen_until timestamptz,
 rating smallint CHECK(rating BETWEEN 1 AND 5),rating_comment text,
 tags text[] NOT NULL DEFAULT '{}',linked_ticket_ids uuid[] NOT NULL DEFAULT '{}',diagnostics jsonb NOT NULL DEFAULT '{}',
 last_customer_activity_at timestamptz,last_agent_activity_at timestamptz,paused_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),warning_sent_at timestamptz,breach_sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS support_tickets_customer ON support_tickets(requester_user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_queue ON support_tickets(status,first_reply_due_at);
CREATE UNIQUE INDEX IF NOT EXISTS support_suspension_ticket ON support_tickets(suspension_id) WHERE suspension_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS support_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,author_user_id uuid REFERENCES users(id),author_kind text NOT NULL CHECK(author_kind IN ('customer','agent','system','external')),kind text NOT NULL DEFAULT 'reply' CHECK(kind IN ('reply','note','event')),body text NOT NULL CHECK(length(body)<=20000),via text NOT NULL DEFAULT 'panel',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS support_messages_thread ON support_messages(ticket_id,created_at);
CREATE INDEX IF NOT EXISTS support_messages_search ON support_messages USING gin(to_tsvector('simple',body));
CREATE TABLE IF NOT EXISTS support_attachments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,message_id uuid REFERENCES support_messages(id) ON DELETE CASCADE,sha256 text NOT NULL,mime text NOT NULL,name text NOT NULL,size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880),bytes bytea NOT NULL);
CREATE TABLE IF NOT EXISTS support_drafts(user_id uuid REFERENCES users(id) ON DELETE CASCADE,ticket_id text NOT NULL DEFAULT 'new',body jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,ticket_id));
CREATE TABLE IF NOT EXISTS support_macros(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,shortcut text NOT NULL,body text NOT NULL,scope text NOT NULL DEFAULT 'team' CHECK(scope IN ('team','personal')),owner_id uuid REFERENCES users(id));
CREATE TABLE IF NOT EXISTS support_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,enabled boolean NOT NULL DEFAULT true,position integer NOT NULL DEFAULT 0,trigger text NOT NULL,conditions jsonb NOT NULL DEFAULT '{}',actions jsonb NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS support_articles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),slug text NOT NULL UNIQUE,title text NOT NULL,body text NOT NULL,category text NOT NULL DEFAULT 'General',visibility text NOT NULL DEFAULT 'draft' CHECK(visibility IN ('customers','public','draft')),helpful_yes integer NOT NULL DEFAULT 0,helpful_no integer NOT NULL DEFAULT 0,updated_by uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS support_articles_search ON support_articles USING gin(to_tsvector('simple',title||' '||body));
CREATE TABLE IF NOT EXISTS support_article_search(query text PRIMARY KEY,count integer NOT NULL DEFAULT 1,no_results integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS support_article_votes(article_id uuid REFERENCES support_articles(id) ON DELETE CASCADE,user_id uuid REFERENCES users(id),helpful boolean NOT NULL,PRIMARY KEY(article_id,user_id));
CREATE TABLE IF NOT EXISTS support_events(id bigserial PRIMARY KEY,ticket_id uuid REFERENCES support_tickets(id) ON DELETE CASCADE,kind text NOT NULL,actor uuid REFERENCES users(id),data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS support_presence(ticket_id uuid REFERENCES support_tickets(id) ON DELETE CASCADE,user_id uuid REFERENCES users(id) ON DELETE CASCADE,seen_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(ticket_id,user_id));
ALTER TABLE plans ADD COLUMN IF NOT EXISTS support_tier text NOT NULL DEFAULT 'standard' CHECK(support_tier IN ('standard','priority'));
ALTER TABLE support_attachments ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES users(id);

ALTER TABLE support_attachments ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS support_inbound_messages(id text PRIMARY KEY,ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS support_ticket_reads (ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(ticket_id,user_id));

-- Mews virtualization is opt-in; existing workloads keep their container runtime.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT 'container' CHECK(runtime IN ('container','vm'));
ALTER TABLE templates ADD COLUMN IF NOT EXISTS vm_config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE servers ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT 'container' CHECK(runtime IN ('container','vm'));
ALTER TABLE servers ADD COLUMN IF NOT EXISTS vm_config jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS vm_media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, kind text NOT NULL CHECK(kind IN ('cloud','iso','drivers')),
 url text NOT NULL, sha256 text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>0), enabled boolean NOT NULL DEFAULT false,
 os text NOT NULL DEFAULT 'linux' CHECK(os IN ('linux','windows')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vm_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vm_networks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, libvirt_name text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('nat','routed')), node_ids uuid[] NOT NULL DEFAULT '{}',
 gateway inet NOT NULL, prefix integer NOT NULL, dns inet[] NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vm_addresses (
 network_id uuid NOT NULL REFERENCES vm_networks(id) ON DELETE CASCADE, address inet NOT NULL,
 server_id uuid REFERENCES servers(id) ON DELETE SET NULL, PRIMARY KEY(network_id,address), UNIQUE(server_id)
);
CREATE TABLE IF NOT EXISTS vm_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 name text NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','ready','failed','deleting')),
 size_mb bigint NOT NULL, job_id uuid REFERENCES jobs(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vm_console_tickets (
 token_hash text PRIMARY KEY, server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('vnc','serial')), expires_at timestamptz NOT NULL, used_at timestamptz
);


-- Durable external delivery and atomic event claims, shared by API replicas.
CREATE TABLE IF NOT EXISTS notification_emissions (
 identity text PRIMARY KEY, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
 payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed')),
 available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_deliveries_pending ON notification_deliveries(available_at) WHERE state='pending';

-- Attribute legacy shared panel channels to the bootstrap administrator so
-- queued delivery can recheck a real principal after permission changes.
UPDATE notification_channels SET user_id=(SELECT id FROM users WHERE role='admin' AND is_super ORDER BY created_at LIMIT 1) WHERE scope='panel' AND user_id IS NULL;

-- Reporting is disabled until a super-administrator explicitly consents and connects GitHub.
CREATE TABLE IF NOT EXISTS usage_reporting (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 consent boolean NOT NULL DEFAULT false,
 consent_at timestamptz,
 policy_hash text,
 installation_id text,
 secret text,
 last_activity_at timestamptz,
 last_report_day date,
 last_report_version text,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error text,
 withdrawal_pending boolean NOT NULL DEFAULT false,
 withdrawal_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO usage_reporting(singleton) VALUES(true) ON CONFLICT DO NOTHING;

ALTER TABLE vm_console_tickets ADD COLUMN IF NOT EXISTS agent_connected boolean NOT NULL DEFAULT false;
-- NOTIFY is delivered after COMMIT, so active binary relays revoke immediately.
CREATE OR REPLACE FUNCTION revoke_vm_console_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb := to_jsonb(OLD); current jsonb := to_jsonb(NEW); payload jsonb;
BEGIN
 IF TG_TABLE_NAME='users' THEN
  IF prior->'disabled' IS NOT DISTINCT FROM current->'disabled' AND prior->'status' IS NOT DISTINCT FROM current->'status' AND prior->'admin_permissions' IS NOT DISTINCT FROM current->'admin_permissions' AND prior->'is_super' IS NOT DISTINCT FROM current->'is_super' AND prior->'totp_secret' IS NOT DISTINCT FROM current->'totp_secret' AND prior->'password_hash' IS NOT DISTINCT FROM current->'password_hash' THEN RETURN NULL; END IF;
  payload=jsonb_build_object('userId',current->>'id');
 ELSIF TG_TABLE_NAME='collaborators' THEN payload=jsonb_build_object('userId',coalesce(current->>'user_id',prior->>'user_id'),'serverId',coalesce(current->>'server_id',prior->>'server_id'));
 ELSIF TG_TABLE_NAME='account_suspensions' THEN payload=jsonb_build_object('userId',coalesce(current->>'user_id',prior->>'user_id'));
 ELSIF TG_TABLE_NAME='servers' THEN
  IF prior->'suspended' IS NOT DISTINCT FROM current->'suspended' AND prior->'node_id' IS NOT DISTINCT FROM current->'node_id' AND prior->'deleted_at' IS NOT DISTINCT FROM current->'deleted_at' AND prior->'observed_status' IS NOT DISTINCT FROM current->'observed_status' THEN RETURN NULL; END IF;
  payload=jsonb_build_object('serverId',current->>'id');
 ELSIF TG_TABLE_NAME='sessions' THEN payload=jsonb_build_object('sessionHash',coalesce(current->>'token_hash',prior->>'token_hash'));
 ELSIF TG_TABLE_NAME='nodes' THEN payload=jsonb_build_object('nodeId',current->>'id');
 ELSE RETURN NULL; END IF;
 PERFORM pg_notify('fledge_vm_revoke',payload::text); RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS vm_revoke_user ON users;
CREATE TRIGGER vm_revoke_user AFTER UPDATE OF disabled,status,admin_permissions,is_super,totp_secret,password_hash ON users FOR EACH ROW EXECUTE FUNCTION revoke_vm_console_authorization();
DROP TRIGGER IF EXISTS vm_revoke_collaborator ON collaborators;
CREATE TRIGGER vm_revoke_collaborator AFTER UPDATE OR DELETE ON collaborators FOR EACH ROW EXECUTE FUNCTION revoke_vm_console_authorization();
DROP TRIGGER IF EXISTS vm_revoke_hold ON account_suspensions;
CREATE TRIGGER vm_revoke_hold AFTER INSERT OR UPDATE ON account_suspensions FOR EACH ROW EXECUTE FUNCTION revoke_vm_console_authorization();
DROP TRIGGER IF EXISTS vm_revoke_server ON servers;
CREATE TRIGGER vm_revoke_server AFTER UPDATE OF suspended,node_id,deleted_at,observed_status ON servers FOR EACH ROW EXECUTE FUNCTION revoke_vm_console_authorization();
DROP TRIGGER IF EXISTS vm_revoke_session ON sessions;
CREATE TRIGGER vm_revoke_session AFTER DELETE OR UPDATE OF expires_at ON sessions FOR EACH ROW EXECUTE FUNCTION revoke_vm_console_authorization();
DROP TRIGGER IF EXISTS vm_revoke_node ON nodes;
CREATE TRIGGER vm_revoke_node AFTER UPDATE OF credential_hash,deleted_at ON nodes FOR EACH ROW EXECUTE FUNCTION revoke_vm_console_authorization();

ALTER TABLE failover_events ADD COLUMN IF NOT EXISTS target_network_id uuid REFERENCES vm_networks(id);
