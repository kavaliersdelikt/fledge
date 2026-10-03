// A throw-away Fledge stack filled with fictional demo data, for taking documentation screenshots.
// Real API and plugin host processes, an empty database, three simulated nodes. Nothing here touches a real installation.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bootStack, client, makeNode, dbQuery, sleep } from '../../api/test/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const { authenticator } = createRequire(join(repo, 'api', 'package.json'))('otplib');
export const WEB = 'http://localhost:3100';
export const API = 'http://localhost:4300';
export const ADMIN = { email: 'maya@fledge.demo', password: 'demo-password-2026' };

export async function bootDemo() {
  const stack = await bootStack({
    db: 'fledge_docs_demo', apiPort: 4300, hostPort: 4593,
    apiEnv: {
      WEB_ORIGIN: WEB, SWEEP_INTERVAL_MS: '3000', SLOW_SWEEP_MS: '10000', RATE_LIMIT_AUTH_WRITE: '5000',
      // Object storage is configured (and never contacted) so the backup features are shown as they look when it is on.
      S3_BUCKET: 'fledge-demo', S3_ACCESS_KEY: 'demo', S3_SECRET_KEY: 'demo-secret-key', S3_ENDPOINT: 'http://127.0.0.1:9',
    },
  });
  const web = spawn(process.execPath, [join(repo, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', '3100', '-H', '127.0.0.1'], { cwd: join(repo, 'web'), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(WEB)).ok) break; } catch { /* starting */ } await sleep(500); }
  const stop = async () => { web.kill(); await stack.stop(); };
  return { stack, stop, c: client(API) };
}

const MB = 1048576;
const rnd = (a, b) => a + Math.random() * (b - a);

export async function seedDemo({ stack, c }) {
  const ok = c.ok;
  const db = (sql, args) => dbQuery(stack.databaseUrl, sql, args);

  // --- Administrator --------------------------------------------------------------------------------------------------------
  ok(await c.call('POST', '/api/auth/bootstrap', ADMIN), 'bootstrap');
  const setup = ok(await c.call('POST', '/api/auth/2fa/setup', {}), '2fa setup');
  ok(await c.call('POST', '/api/auth/2fa/confirm', { code: authenticator.generate(setup.secret) }), '2fa confirm');
  const admin = (await db('SELECT id FROM users WHERE email=$1', [ADMIN.email]))[0];

  // --- Nodes (simulated agents) -------------------------------------------------------------------------------------------
  const nodeSpecs = [
    { name: 'frankfurt-01', location: 'Frankfurt', memoryMb: 65536, cpuPercent: 3200, diskMb: 1536000, publicHost: 'fra1.play.example.net' },
    { name: 'helsinki-01', location: 'Helsinki', memoryMb: 32768, cpuPercent: 1600, diskMb: 768000, publicHost: 'hel1.play.example.net' },
    { name: 'ashburn-01', location: 'Ashburn', memoryMb: 32768, cpuPercent: 1600, diskMb: 768000, publicHost: 'iad1.play.example.net' },
  ];
  const nodes = [];
  for (const s of nodeSpecs) {
    const n = await makeNode(c, s.name, s.location, { memoryMb: s.memoryMb, cpuPercent: s.cpuPercent, diskMb: s.diskMb, headroomMb: 2048 });
    n.spec = s; n.states = {};
    nodes.push(n);
  }
  const agent = { os: 'linux', arch: 'amd64', updatable: true, quota: { mode: 'auto', supported: true, enforced: true }, sftp: { listening: true, port: 2022 } };
  const runAgents = async () => {
    for (;;) {
      for (const n of nodes) {
        try {
          const servers = Object.entries(n.states).map(([id, st]) => ({
            id, status: st.status,
            ...(st.status === 'running' ? { usage: { cpuPercent: Math.round(rnd(st.cpu * 0.6, st.cpu * 1.3) * 10) / 10, memoryBytes: Math.round(st.mem * MB * rnd(0.82, 0.96)), memoryLimitBytes: st.mem * MB }, diskBytes: st.disk * MB, diskEnforced: true } : {}),
          }));
          await c.call('POST', '/api/agent/heartbeat', { version: '0.6.1.1', agent, usage: { MemTotalMb: n.spec.memoryMb, MemAvailableMb: Math.round(n.spec.memoryMb * rnd(0.45, 0.6)), diskFreeMb: Math.round(n.spec.diskMb * 0.62), cpuCount: n.spec.cpuPercent / 100 }, servers, held: Object.keys(n.states) }, n.headers);
          for (let i = 0; i < 10; i++) {
            const r = await c.call('GET', '/api/agent/jobs', undefined, n.headers);
            const job = r.data?.job;
            if (!job) break;
            await finish(n, job);
          }
        } catch { /* the stack is shutting down */ }
      }
      await sleep(2500);
    }
  };
  const fileItems = [
    ['logs', 'directory', 0], ['plugins', 'directory', 0], ['world', 'directory', 0], ['world_nether', 'directory', 0], ['world_the_end', 'directory', 0],
    ['server.properties', 'file', 1432], ['paper.jar', 'file', 51234567], ['bukkit.yml', 'file', 1121], ['spigot.yml', 'file', 5780], ['eula.txt', 'file', 158],
    ['ops.json', 'file', 124], ['whitelist.json', 'file', 2], ['banned-players.json', 'file', 2],
  ];
  async function finish(n, job) {
    const p = job.payload || {};
    let result = { ok: true };
    if (job.server && ['create', 'start', 'restart', 'configure', 'restore', 'reinstall'].includes(job.kind)) {
      const old = n.states[job.server.id];
      n.states[job.server.id] = { status: 'running', cpu: old?.cpu ?? rnd(8, 60), mem: job.server.memoryMb || 2048, disk: old?.disk ?? Math.round(rnd(600, 4200)) };
    }
    if (job.server && ['stop', 'kill'].includes(job.kind) && n.states[job.server.id]) n.states[job.server.id].status = 'stopped';
    if (job.server && job.kind === 'delete') delete n.states[job.server.id];
    if (job.kind === 'file.list') result = { path: p.path || '/', items: (p.path || '/') === '/' ? fileItems.map(([name, type, size]) => ({ name, path: '/' + name, type, size, modifiedAt: new Date(Date.now() - rnd(1, 90) * 3600_000).toISOString() })) : [] };
    if (job.kind === 'logs') result = { output: '[12:01:14 INFO]: Done (4.2s)! For help, type "help"' };
    if (job.kind === 'command') result = { output: 'ok' };
    if (job.kind === 'backup') result = { sizeBytes: Math.round(rnd(80, 900) * MB) };
    if (job.kind === 'file.fetch') result = { ok: true, sizeBytes: p.size };
    await c.call('POST', `/api/agent/jobs/${job.id}/result`, { attempt: job.attempt, success: true, result }, n.headers);
  }
  const LINES = [
    '[12:03:51 INFO]: Starting minecraft server version 1.21.4', '[12:03:52 INFO]: Loading properties', '[12:03:56 INFO]: Preparing level "world"',
    '[12:04:00 INFO]: Done preparing level "world" (4.2s)', '[12:04:00 INFO]: RCON running on 0.0.0.0:25575', '[12:04:01 INFO]: Done (8.7s)! For help, type "help"',
    '[12:11:07 INFO]: Mara_Plays[/203.0.113.24:51322] logged in with entity id 128 at (212.5, 64.0, -88.5)', '[12:11:08 INFO]: Mara_Plays joined the game',
    '[12:14:40 INFO]: <Mara_Plays> gg', '[12:16:02 INFO]: TobiBuilds joined the game', '[12:19:31 INFO]: [Dynmap] Rendering world: 38% complete',
    '[12:22:15 INFO]: Mara_Plays issued server command: /home',
  ];
  const connectStream = (n) => {
    const ws = new WebSocket(API.replace('http', 'ws') + '/api/agent/stream', { headers: { authorization: n.headers.authorization, 'x-node-id': n.id } });
    const timers = new Map();
    const log = (id, text) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'log', serverId: id, data: Buffer.from(text + '\r\n').toString('base64') }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'subscribe' && !timers.has(m.serverId)) {
        LINES.forEach((l) => log(m.serverId, l));
        timers.set(m.serverId, setInterval(() => {
          const st = n.states[m.serverId];
          if (st && ws.readyState === 1) ws.send(JSON.stringify({ type: 'sample', serverId: m.serverId, cpuPercent: Math.round(rnd(st.cpu * 0.6, st.cpu * 1.3) * 10) / 10, memoryBytes: Math.round(st.mem * MB * rnd(0.82, 0.96)), memoryLimitBytes: st.mem * MB }));
        }, 2000));
      }
      if (m.type === 'unsubscribe') { clearInterval(timers.get(m.serverId)); timers.delete(m.serverId); }
    };
    ws.onclose = () => { for (const t of timers.values()) clearInterval(t); setTimeout(() => connectStream(n), 2000); };
    ws.onerror = () => {};
  };
  void runAgents();
  await sleep(4000);
  for (const n of nodes) connectStream(n);
  for (const n of nodes) ok(await c.call('PATCH', `/api/nodes/${n.id}`, { publicHost: n.spec.publicHost }), 'public host');

  // --- Customers ---------------------------------------------------------------------------------------------------------------
  const people = [
    ['alex@orbit-games.example', { maxServers: 4, maxMemoryMb: 12288, maxCpuPercent: 800, maxDiskMb: 80000, maxBackups: 20, maxExtraPorts: 6 }],
    ['sam@blockworks.example', { maxServers: 2, maxMemoryMb: 6144, maxExtraPorts: 2 }],
    ['jo@northwind.example', {}],
    ['riley@lantern-club.example', { maxServers: 3 }],
    ['kim@pixelhaven.example', {}],
  ];
  const customers = [];
  for (const [email, quota] of people) {
    const cu = ok(await c.call('POST', '/api/customers', { email }), 'customer ' + email);
    if (Object.keys(quota).length) ok(await c.call('PATCH', `/api/customers/${cu.id}`, { quota }), 'quota');
    customers.push(cu);
  }

  // --- Servers -----------------------------------------------------------------------------------------------------------------
  const templates = ok(await c.call('GET', '/api/templates'), 'templates');
  const has = (id) => templates.some((t) => t.id === id);
  const pick = (...ids) => ids.find(has);
  const specs = [
    { name: 'Survival SMP', owner: 0, tpl: pick('minecraft-paper', 'minecraft-java'), node: 0, mem: 6144, vars: { VERSION: '1.21.4' }, cpu: 140, disk: 3800 },
    { name: 'Creative Plots', owner: 0, tpl: pick('minecraft-paper', 'minecraft-java'), node: 0, mem: 3072, vars: { VERSION: '1.21.4' }, cpu: 35, disk: 1900 },
    { name: 'Modded Fabric', owner: 1, tpl: pick('minecraft-fabric', 'minecraft-java'), node: 1, mem: 4096, vars: { VERSION: '1.21.4' }, cpu: 95, disk: 2600 },
    { name: 'Valheim Vikings', owner: 2, tpl: pick('valheim'), node: 1, mem: 4096, vars: {}, cpu: 60, disk: 5200 },
    { name: 'Skyblock', owner: 3, tpl: pick('minecraft-paper', 'minecraft-java'), node: 2, mem: 3072, vars: { VERSION: '1.21.4' }, cpu: 20, disk: 900 },
    { name: 'Bedrock Lobby', owner: 4, tpl: pick('minecraft-bedrock', 'minecraft-java'), node: 2, mem: 2048, vars: {}, cpu: 12, disk: 700 },
  ].filter((s) => s.tpl);
  const servers = [];
  for (const s of specs) {
    const srv = ok(await c.call('POST', '/api/servers', { name: s.name, ownerId: customers[s.owner].id, templateId: s.tpl, nodeId: nodes[s.node].id, memoryMb: s.mem, force: true }), 'server ' + s.name);
    servers.push({ ...srv, spec: s });
    await sleep(500);
  }
  await sleep(6000);
  for (const s of servers) {
    const n = nodes.find((x) => x.id === s.nodeId);
    if (n?.states[s.id]) { n.states[s.id].cpu = s.spec.cpu; n.states[s.id].disk = s.spec.disk; }
    if (Object.keys(s.spec.vars).length) await c.call('PATCH', `/api/servers/${s.id}`, { variables: { ...(s.variables || {}), ...s.spec.vars } });
  }
  await sleep(4000);

  // --- Fabric add-ons, ports, schedules, crash policy -----------------------------------------------------------------
  const fabric = servers.find((s) => s.name === 'Modded Fabric') || servers[0];
  const paper = servers[0];
  await c.call('POST', `/api/plugins`, { source: 'bundled', id: 'modrinth-mods', acceptPermissions: true });
  // The plugin browser stays uninstalled so the install wizard can be shown.
  for (const id of ['modrinth-mods']) ok(await c.call('PATCH', `/api/plugins/${id}`, { enabled: true }), 'enable ' + id);
  await sleep(1500);
  for (const q of ['lithium', 'fabric-api']) {
    const found = await c.call('GET', `/api/servers/${fabric.id}/addons/search?pluginId=modrinth-mods&q=${q}&limit=1`);
    const hit = found.data?.items?.[0];
    if (hit) await c.call('POST', `/api/servers/${fabric.id}/addons/install`, { pluginId: 'modrinth-mods', projectId: hit.id });
    await sleep(1500);
  }
  await c.call('POST', `/api/servers/${paper.id}/ports`, { container: 25575, protocol: 'tcp', label: 'RCON' });
  await c.call('POST', `/api/servers/${paper.id}/ports`, { container: 8123, protocol: 'tcp', label: 'Dynmap' });
  await sleep(1500);
  ok(await c.call('POST', `/api/servers/${paper.id}/schedules`, { name: 'Nightly restart', cron: '0 4 * * *', timezone: 'Europe/Berlin', missed: 'skip', tasks: [{ action: 'command', command: 'say The server restarts in 60 seconds' }, { action: 'wait', seconds: 60 }, { action: 'backup' }, { action: 'power', power: 'restart' }] }), 'schedule');
  ok(await c.call('POST', `/api/servers/${paper.id}/schedules`, { name: 'Autosave', intervalMinutes: 30, tasks: [{ action: 'command', command: 'save-all' }] }), 'schedule 2');
  ok(await c.call('PUT', `/api/servers/${paper.id}/crash-policy`, { mode: 'on-failure', maxRestarts: 3, windowMinutes: 10, backoffSeconds: [10, 30, 60] }), 'crash policy');

  // --- Backups, history, notifications, events ---------------------------------------------------------------------------
  for (const s of servers.slice(0, 4)) {
    for (let i = 0; i < 4; i++) {
      await db("INSERT INTO backups(server_id,object_key,state,size_bytes,created_at,completed_at) VALUES($1,$2,'succeeded',$3,now()-($4||' hours')::interval,now()-($4||' hours')::interval)", [s.id, `servers/${s.id}/backups/${s.id.slice(0, 8)}-${i}.tar.gz`, Math.round(rnd(120, 780) * MB), String(i * 20 + 3)]);
    }
  }
  for (const s of servers) {
    await db(`INSERT INTO server_metrics(server_id,res,bucket,cpu_sum,cpu_max,mem_sum,mem_max,disk_bytes,n)
      SELECT $1::uuid,1,date_trunc('minute',now())-(g||' minutes')::interval,
        (($2::float8+($2::float8*0.5*sin(g/9.0))+random()*8)*4),($2::float8*1.8+random()*10),($3::float8*0.84*4),($3::float8*0.93),$4::bigint,4
      FROM generate_series(1,180) g ON CONFLICT DO NOTHING`, [s.id, s.spec.cpu, s.spec.mem * MB, s.spec.disk * MB]);
  }
  await db(`INSERT INTO notifications(user_id,kind,severity,title,body,server_id,created_at) VALUES
    ($1,'server.crashed','bad','Skyblock crashed','exit code 137, out of memory',$2,now()-interval '38 minutes'),
    ($1,'server.recovered','ok','Skyblock is running again','Restarted automatically after 10 seconds',$2,now()-interval '37 minutes'),
    ($1,'backup.failed','bad','A backup of Survival SMP failed','The object storage did not answer',$3,now()-interval '3 hours'),
    ($1,'server.disk_high','warn','Valheim Vikings disk is 91% full','4.7 GB of 5.2 GB used',$4,now()-interval '5 hours'),
    ($1,'update.available','info','Fledge 0.7.0.1 is available','Open Updates to see what is new',NULL,now()-interval '1 day'),
    ($1,'node.online','ok','ashburn-01 is back online','It was offline for 4 minutes',NULL,now()-interval '2 days')`,
  [admin.id, servers[4]?.id ?? servers[0].id, servers[0].id, servers[3]?.id ?? servers[0].id]);
  await db(`INSERT INTO server_events(server_id,kind,message,at) VALUES
    ($1,'crash','The server stopped unexpectedly (exit code 137, out of memory)',now()-interval '38 minutes'),
    ($1,'restart','Restarting automatically in 10 seconds (1 of 3 within 10 minutes)',now()-interval '38 minutes'),
    ($1,'recovered','The server is running again',now()-interval '37 minutes')`, [servers[4]?.id ?? servers[0].id]);
  ok(await c.call('POST', '/api/notification-channels', { name: 'Ops Discord', kind: 'discord', url: 'https://discord.com/api/webhooks/000000000000000000/demo', events: ['server.crashed', 'server.crashloop', 'backup.failed', 'node.offline'] }), 'channel');
  return { admin, nodes, customers, servers, paper, fabric, totpSecret: setup.secret };
}

/** Puts fresh console lines in the relay table (they expire after two minutes). */
export async function seedConsole(stack, serverId) {
  const lines = [
    '[12:03:51 INFO]: Starting minecraft server version 1.21.4', '[12:03:52 INFO]: Loading properties', '[12:03:52 INFO]: This server is running Paper version 1.21.4-232-main (MC: 1.21.4)',
    '[12:03:56 INFO]: Preparing level "world"', '[12:03:58 INFO]: Preparing spawn area: 41%', '[12:04:00 INFO]: Done preparing level "world" (4.2s)',
    '[12:04:00 INFO]: RCON running on 0.0.0.0:25575', '[12:04:01 INFO]: Done (8.7s)! For help, type "help"',
    '[12:11:07 INFO]: Mara_Plays[/203.0.113.24:51322] logged in with entity id 128 at (212.5, 64.0, -88.5)', '[12:11:08 INFO]: Mara_Plays joined the game',
    '[12:14:40 INFO]: Mara_Plays: gg', '[12:16:02 INFO]: TobiBuilds joined the game', '[12:19:31 INFO]: [Dynmap] Rendering world: 38% complete',
    '[12:22:15 INFO]: Mara_Plays issued server command: /home', '[12:25:42 INFO]: TobiBuilds left the game',
  ];
  for (const l of lines) await dbQuery(stack.databaseUrl, "INSERT INTO console_events(server_id,frame) VALUES($1,$2)", [serverId, JSON.stringify({ type: 'log', serverId, data: Buffer.from(l + '\r\n').toString('base64') })]);
}
