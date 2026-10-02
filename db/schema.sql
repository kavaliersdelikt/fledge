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
