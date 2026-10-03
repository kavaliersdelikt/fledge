import type {FastifyInstance} from 'fastify';
import {pool,hash,admin,fail} from './core.js';

async function extraMetrics(){
 const one=async(sql:string)=>(await pool.query(sql)).rows;
 const [plugins,addons,runs,loops,failing,sessions,passkeys]=await Promise.all([
  one("SELECT enabled,count(*)::int n FROM plugins GROUP BY enabled"),one("SELECT state,count(*)::int n FROM server_addons GROUP BY state"),one("SELECT state,count(*)::int n FROM schedule_runs WHERE started_at>now()-interval '24 hours' GROUP BY state"),
  one("SELECT count(*)::int n FROM servers WHERE deleted_at IS NULL AND crash_state->>'loop'='true'"),one("SELECT count(*)::int n FROM notification_channels WHERE enabled AND last_status='failed'"),one("SELECT count(*)::int n FROM sessions WHERE expires_at>now()"),one("SELECT count(*)::int n FROM passkeys")]);
 const q=(v:unknown)=>JSON.stringify(String(v));
 const lines=(rows:any[],fmt:(r:any)=>string)=>rows.map(fmt).join('\n');
 return ['# HELP fledge_plugins Installed plugins by state','# TYPE fledge_plugins gauge',lines(plugins,r=>`fledge_plugins{enabled=${q(r.enabled)}} ${r.n}`),
  '# TYPE fledge_server_addons gauge',lines(addons,r=>`fledge_server_addons{state=${q(r.state)}} ${r.n}`),
  '# HELP fledge_schedule_runs Schedule runs in the last 24 hours','# TYPE fledge_schedule_runs gauge',lines(runs,r=>`fledge_schedule_runs{state=${q(r.state)}} ${r.n}`),
  '# HELP fledge_servers_crash_looping Servers whose automatic restarts were stopped','# TYPE fledge_servers_crash_looping gauge',`fledge_servers_crash_looping ${loops[0].n}`,
  '# HELP fledge_notification_channels_failing Channels whose last delivery failed','# TYPE fledge_notification_channels_failing gauge',`fledge_notification_channels_failing ${failing[0].n}`,
  '# TYPE fledge_sessions gauge',`fledge_sessions ${sessions[0].n}`,'# TYPE fledge_passkeys gauge',`fledge_passkeys ${passkeys[0].n}`].filter(Boolean).join('\n')+'\n';
}
// Shared, atomic fixed windows: limits remain effective across API replicas.
export function registerOperations(app:FastifyInstance){
 app.addHook('onRequest',async(req,reply)=>{
  if(req.url.split('?')[0]==='/api/health'||req.method==='OPTIONS')return;
  const agent=req.url.startsWith('/api/agent/'),auth=req.url.startsWith('/api/auth/'),write=!['GET','HEAD'].includes(req.method);
  const identity=agent?`${req.ip}:${req.headers['x-node-id']||''}`:req.ip;
  const limit=agent?1200:auth&&write?(Number(process.env.RATE_LIMIT_AUTH_WRITE)||40):write?180:600;
  const key=hash(`${identity}:${agent?'agent':auth?'auth':write?'write':'read'}:${Math.floor(Date.now()/60000)}`);
  const r=await pool.query("INSERT INTO request_limits(bucket_hash,expires_at) VALUES($1,now()+interval '2 minutes') ON CONFLICT(bucket_hash) DO UPDATE SET attempts=request_limits.attempts+1 RETURNING attempts",[key]);
  reply.header('X-RateLimit-Limit',limit);
  if(r.rows[0].attempts>limit){reply.header('Retry-After',60);fail(429,'Too many requests. Please try again in a minute.');}
 });
 app.get('/api/metrics',async(req,reply)=>{
  admin(req);
  const [nodes,jobs,servers,events,unprotected]=await Promise.all([pool.query("SELECT status,count(*)::int AS n FROM nodes WHERE deleted_at IS NULL GROUP BY status"),pool.query('SELECT state,count(*)::int AS n FROM jobs GROUP BY state'),pool.query("SELECT observed_status AS status,count(*)::int AS n FROM servers WHERE deleted_at IS NULL GROUP BY observed_status"),pool.query("SELECT state,count(*)::int AS n FROM failover_events GROUP BY state"),pool.query("SELECT count(*)::int AS n FROM servers s WHERE s.deleted_at IS NULL AND s.failover_enabled AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.server_id=s.id AND b.state='succeeded')")]);
  const extra=await extraMetrics();
  const label=(s:string)=>JSON.stringify(s).replace(/\\r/g,'');
  reply.type('text/plain; version=0.0.4');
  return '# HELP fledge_nodes Registered nodes by connection state\n# TYPE fledge_nodes gauge\n'+nodes.rows.map(r=>`fledge_nodes{status=${label(r.status)}} ${r.n}`).join('\n')+'\n# TYPE fledge_jobs gauge\n'+jobs.rows.map(r=>`fledge_jobs{state=${label(r.state)}} ${r.n}`).join('\n')+'\n# TYPE fledge_servers gauge\n'+servers.rows.map(r=>`fledge_servers{status=${label(r.status)}} ${r.n}`).join('\n')+'\n# HELP fledge_failover_events Failover and migration events by state\n# TYPE fledge_failover_events gauge\n'+events.rows.map(r=>`fledge_failover_events{state=${label(r.state)}} ${r.n}`).join('\n')+'\n# HELP fledge_servers_without_backup Failover-enabled servers that have no successful backup\n# TYPE fledge_servers_without_backup gauge\nfledge_servers_without_backup '+unprotected.rows[0].n+'\n'+extra;
 });
}
