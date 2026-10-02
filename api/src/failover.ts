import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,asId,audit} from './core.js';
import {settings} from './settings.js';
import {backupEnabled} from './storage.js';

// ---------------------------------------------------------------------------
// Automatic failover, planned migration and the health data behind them.
//
// A server's files live on one node. When that node stays offline longer than the
// configured wait, the server is re-homed on another node and restored from its newest
// backup (object storage). A planned migration does the same on purpose: stop on the old
// node, take a final backup, restore on the new one. When the old node returns, the stale
// copy is evicted so two nodes never run the same server.
// ---------------------------------------------------------------------------

const ACTIVE=['blocked','backing-up','restoring'];
type Settings=Awaited<ReturnType<typeof settings>>['failover'];

export async function notify(title:string,detail:Record<string,unknown>={}){
 const url=(await settings()).failover.webhookUrl;
 if(!url)return;
 const text=`Fledge: ${title}`;
 try{
  // `text` and `content` make the payload work with Slack, Discord and Mattermost; `event` carries the data.
  await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,content:text,event:{title,...detail,at:new Date().toISOString()}}),signal:AbortSignal.timeout(5000)});
 }catch{/* a broken webhook must never block recovery */}
}

type Need={memory:number;cpu:number;disk:number;ports:{offset:number;protocol:string}[];location:string|null};
async function pickNode(c:any,need:Need,opts:{exclude:string[];sameLocationOnly:boolean;preferNode?:string|null}){
 const nodes=(await c.query("SELECT * FROM nodes WHERE status='connected' AND NOT draining AND deleted_at IS NULL AND NOT (id=ANY($1::uuid[])) AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR location=$3) ORDER BY (location IS NOT DISTINCT FROM $4::text) DESC,(memory_mb-headroom_mb) DESC,id FOR UPDATE",[opts.exclude,opts.preferNode||null,opts.sameLocationOnly?need.location:null,need.location])).rows;
 const rejected:string[]=[];
 for(const n of nodes){
  const used=(await c.query('SELECT coalesce(sum(memory_mb),0) AS mem,coalesce(sum(cpu_percent),0) AS cpu,coalesce(sum(disk_mb),0) AS disk FROM servers WHERE node_id=$1 AND deleted_at IS NULL',[n.id])).rows[0];
  if(Number(used.mem)+need.memory>n.memory_mb-n.headroom_mb||Number(used.cpu)+need.cpu>n.cpu_percent||Number(used.disk)+need.disk>n.disk_mb){rejected.push(`${n.name}: not enough reserved capacity`);continue;}
  if(Number.isFinite(Number(n.usage?.diskFreeMb))&&Number(n.usage.diskFreeMb)<need.disk+n.headroom_mb){rejected.push(`${n.name}: not enough free disk`);continue;}
  const occupied=new Set((await c.query('SELECT port,protocol FROM allocations WHERE node_id=$1',[n.id])).rows.map((x:any)=>`${x.port}/${x.protocol}`));
  for(let p=20000;p<=50000;p++)if(need.ports.every(x=>p+x.offset<=65535&&!occupied.has(`${p+x.offset}/${x.protocol}`)))return {node:n,port:p,rejected};
  rejected.push(`${n.name}: no free ports`);
 }
 return {node:null,port:0,rejected:rejected.length?rejected:['no other connected node is available']};
}

async function newestBackup(serverId:string){
 return (await pool.query("SELECT id,created_at,size_bytes,EXTRACT(EPOCH FROM now()-created_at)::int AS age FROM backups WHERE server_id=$1 AND state='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1",[serverId])).rows[0] as {id:string;created_at:string;size_bytes:string|null;age:number}|undefined;
}

type Plan={ok:boolean;blockers:string[];backup?:{id:string;age:number};target?:{id:string;name:string;port:number}};
/** What would happen to a server right now, without changing anything. */
export async function planServer(server:any,cfg:Settings,excludeNodes:string[],useBackup?:{id:string;age:number}):Promise<Plan>{
 const blockers:string[]=[];
 let backup=useBackup;
 if(!backup){
  const b=await newestBackup(server.id);
  if(!(await backupEnabled())&&!cfg.allowWithoutBackup)blockers.push('Object storage is off, so there is no backup to restore from');
  else if(!b){if(!cfg.allowWithoutBackup)blockers.push('No successful backup exists');}
  else if(cfg.maxBackupAgeHours>0&&b.age>cfg.maxBackupAgeHours*3600)blockers.push(`The newest backup is ${Math.round(b.age/3600)} h old (limit ${cfg.maxBackupAgeHours} h)`);
  else backup={id:b.id,age:b.age};
 }
 const tpl=(await pool.query('SELECT internal_ports FROM templates WHERE id=$1',[server.template_id])).rows[0];
 const c=await pool.connect();let target:any;
 try{
  await c.query('BEGIN');
  const r=await pickNode(c,{memory:server.memory_mb,cpu:server.cpu_percent,disk:server.disk_mb,ports:tpl?.internal_ports||[],location:server.location||null},{exclude:excludeNodes,sameLocationOnly:cfg.sameLocationOnly});
  await c.query('ROLLBACK');
  if(r.node)target={id:r.node.id,name:r.node.name,port:r.port};else blockers.push(...r.rejected);
 }finally{c.release();}
 return {ok:!blockers.length,blockers,backup,target};
}

/** Re-homes a server and queues the jobs that rebuild it. Returns the new event id. */
async function moveServer(serverId:string,opts:{kind:'failover'|'migration';reason:string;actor:string|null;backup?:{id:string;age:number}|null;fromNode:string;preferNode?:string|null}){
 const cfg=(await settings()).failover;
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const s=(await c.query("SELECT s.*,n.location,t.internal_ports FROM servers s JOIN nodes n ON n.id=s.node_id JOIN templates t ON t.id=s.template_id WHERE s.id=$1 AND s.deleted_at IS NULL FOR UPDATE OF s",[serverId])).rows[0];
  if(!s||s.node_id!==opts.fromNode||s.observed_status==='deleting'){await c.query('ROLLBACK');return null;}
  const r=await pickNode(c,{memory:s.memory_mb,cpu:s.cpu_percent,disk:s.disk_mb,ports:s.internal_ports,location:s.location},{exclude:[opts.fromNode],sameLocationOnly:cfg.sameLocationOnly,preferNode:opts.preferNode});
  if(!r.node){await c.query('ROLLBACK');throw Object.assign(new Error(r.rejected.join('; ')),{blocked:true});}
  // Pending work on the old node no longer applies to this server.
  const cancelled=await c.query("UPDATE jobs SET state='failed',error='Server was moved to another node',finished_at=now(),lease_until=NULL WHERE server_id=$1 AND state IN ('queued','running') RETURNING id",[serverId]);
  if(cancelled.rowCount)await c.query("UPDATE backups SET state='failed',error='Server was moved to another node',completed_at=now() WHERE job_id=ANY($1::uuid[]) AND state IN ('queued','running')",[cancelled.rows.map((x:any)=>x.id)]);
  await c.query('DELETE FROM allocations WHERE server_id=$1',[serverId]);
  for(const x of s.internal_ports)await c.query('INSERT INTO allocations(node_id,server_id,port,protocol) VALUES($1,$2,$3,$4)',[r.node.id,serverId,r.port+x.offset,x.protocol]);
  await c.query("UPDATE servers SET node_id=$1,port=$2,observed_status='provisioning',usage='{}'::jsonb,updated_at=now() WHERE id=$3",[r.node.id,r.port,serverId]);
  await c.query("INSERT INTO jobs(node_id,server_id,kind,created_at) VALUES($1,$2,'create',clock_timestamp())",[r.node.id,serverId]);
  let jobId:string|null=null;
  if(opts.backup)jobId=(await c.query("INSERT INTO jobs(node_id,server_id,kind,payload,created_at) VALUES($1,$2,'restore',$3,clock_timestamp()) RETURNING id",[r.node.id,serverId,JSON.stringify({backupId:opts.backup.id,failover:true})])).rows[0].id;
  else jobId=(await c.query("SELECT id FROM jobs WHERE server_id=$1 AND kind='create' ORDER BY created_at DESC LIMIT 1",[serverId])).rows[0].id;
  if(s.desired_status!=='running'){jobId=(await c.query("INSERT INTO jobs(node_id,server_id,kind,created_at) VALUES($1,$2,'stop',clock_timestamp()) RETURNING id",[r.node.id,serverId])).rows[0].id;}
  await c.query("DELETE FROM failover_events WHERE server_id=$1 AND state IN ('blocked','backing-up')",[serverId]);
  const ev=(await c.query("INSERT INTO failover_events(server_id,kind,state,reason,from_node,to_node,backup_id,data_age_seconds,job_id,actor_id) VALUES($1,$2,'restoring',$3,$4,$5,$6,$7,$8,$9) RETURNING id",[serverId,opts.kind,opts.reason,opts.fromNode,r.node.id,opts.backup?.id||null,opts.backup?.age??null,jobId,opts.actor])).rows[0];
  await c.query('COMMIT');
  await audit(opts.actor,`server.${opts.kind}`,'server',serverId,{from:opts.fromNode,to:r.node.id,backupId:opts.backup?.id||null,reason:opts.reason});
  return {eventId:ev.id as string,toNode:r.node.id as string,toName:r.node.name as string,serverName:s.name as string};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}

async function recordBlocked(serverId:string,fromNode:string,reason:string){
 const open=(await pool.query("SELECT id,state,reason FROM failover_events WHERE server_id=$1 AND state IN ('blocked','backing-up','restoring')",[serverId])).rows[0];
 if(open){if(open.state==='blocked'&&open.reason!==reason)await pool.query("UPDATE failover_events SET reason=$2,updated_at=now() WHERE id=$1",[open.id,reason]);return false;}
 await pool.query("INSERT INTO failover_events(server_id,kind,state,reason,from_node) VALUES($1,'failover','blocked',$2,$3) ON CONFLICT DO NOTHING",[serverId,reason,fromNode]);
 return true;
}

async function startFailover(server:any,cfg:Settings,reason:string,actor:string|null){
 const plan=await planServer(server,cfg,[server.node_id]);
 if(!plan.ok){
  const first=await recordBlocked(server.id,server.node_id,plan.blockers.join('; '));
  if(first)await notify(`${server.name} cannot be recovered automatically`,{server:server.name,blockers:plan.blockers});
  return null;
 }
 try{
  const r=await moveServer(server.id,{kind:'failover',reason,actor,backup:plan.backup||null,fromNode:server.node_id});
  if(r)await notify(`${r.serverName} is being recovered on ${r.toName}`,{server:r.serverName,toNode:r.toName,dataAgeMinutes:plan.backup?Math.round(plan.backup.age/60):null,reason});
  return r;
 }catch(e:any){
  if(e?.blocked){await recordBlocked(server.id,server.node_id,e.message);return null;}
  throw e;
 }
}

/** Settles events whose jobs have finished. */
async function advanceEvents(){
 // A node that is back makes its servers' blocked recoveries moot.
 await pool.query("DELETE FROM failover_events e USING servers s, nodes n WHERE e.state='blocked' AND s.id=e.server_id AND n.id=s.node_id AND n.status='connected'");
 const rows=(await pool.query("SELECT e.*,s.name AS server_name,s.node_id AS current_node,j.state AS job_state,j.error AS job_error FROM failover_events e JOIN servers s ON s.id=e.server_id LEFT JOIN jobs j ON j.id=e.job_id WHERE e.state IN ('backing-up','restoring')")).rows;
 for(const e of rows){
  if(e.state==='restoring'){
   // Any failed step (not only the last one) means the server did not come back.
   const bad=(await pool.query("SELECT error FROM jobs WHERE server_id=$1 AND created_at>=$2 AND state='failed' AND kind IN ('create','restore','stop','start') ORDER BY created_at LIMIT 1",[e.server_id,e.started_at])).rows[0];
   if(bad){
    await pool.query("UPDATE jobs SET state='failed',error='An earlier recovery step failed',finished_at=now(),lease_until=NULL WHERE server_id=$1 AND created_at>=$2 AND state='queued'",[e.server_id,e.started_at]);
    e.job_state='failed';e.job_error=bad.error||'A recovery step failed';
   }
   if(e.job_state==='succeeded'){
    await pool.query("UPDATE failover_events SET state='completed',finished_at=now(),updated_at=now() WHERE id=$1",[e.id]);
    // A planned move leaves a live copy behind; remove it only now that the new one works.
    if(e.kind==='migration'&&e.from_node)await pool.query("INSERT INTO jobs(node_id,kind,payload) VALUES($1,'evict',$2)",[e.from_node,JSON.stringify({serverId:e.server_id})]);
    await notify(e.kind==='migration'?`${e.server_name} was moved`:`${e.server_name} is back online`,{server:e.server_name,kind:e.kind});
   }else if(e.job_state==='failed'||(e.job_id&&!e.job_state)){
    const msg=e.job_error||'The recovery job failed';
    await pool.query("UPDATE failover_events SET state='failed',error=$2,finished_at=now(),updated_at=now() WHERE id=$1",[e.id,msg]);
    await pool.query("UPDATE servers SET observed_status='failed' WHERE id=$1 AND deleted_at IS NULL",[e.server_id]);
    await notify(`Recovery of ${e.server_name} failed`,{server:e.server_name,error:msg});
   }
  }else if(e.state==='backing-up'){
   if(e.job_state==='failed'){
    await pool.query("UPDATE failover_events SET state='failed',error=$2,finished_at=now(),updated_at=now() WHERE id=$1",[e.id,e.job_error||'The final backup failed']);
    // The server was stopped for the move; bring it back where it was.
    await pool.query("INSERT INTO jobs(node_id,server_id,kind) SELECT node_id,id,'start' FROM servers WHERE id=$1 AND desired_status='running' AND deleted_at IS NULL",[e.server_id]);
    await notify(`Migration of ${e.server_name} failed`,{server:e.server_name,error:e.job_error});
   }else if(e.job_state==='succeeded'){
    const b=(await pool.query("SELECT id,EXTRACT(EPOCH FROM now()-created_at)::int AS age FROM backups WHERE job_id=$1 AND state='succeeded'",[e.job_id])).rows[0];
    if(!b){await pool.query("UPDATE failover_events SET state='failed',error='Final backup is missing',finished_at=now(),updated_at=now() WHERE id=$1",[e.id]);continue;}
    await pool.query("DELETE FROM failover_events WHERE id=$1",[e.id]);
    try{
     const r=await moveServer(e.server_id,{kind:'migration',reason:e.reason,actor:e.actor_id,backup:{id:b.id,age:b.age},fromNode:e.from_node,preferNode:e.to_node});
     if(r)await notify(`${r.serverName} is moving to ${r.toName}`,{server:r.serverName});
    }catch(err:any){
     await pool.query("INSERT INTO failover_events(server_id,kind,state,reason,from_node,to_node,error,finished_at) VALUES($1,'migration','failed',$2,$3,$4,$5,now())",[e.server_id,e.reason,e.from_node,e.to_node,err.message]);
     // Bring the stopped server back where it was.
     await pool.query("INSERT INTO jobs(node_id,server_id,kind) SELECT node_id,id,'start' FROM servers WHERE id=$1 AND desired_status='running' AND deleted_at IS NULL",[e.server_id]);
    }
   }
  }
 }
}

/** Records nodes going down and coming back, and tells the webhook. */
async function trackNodes(resumed:Date){
 const down=(await pool.query("UPDATE nodes SET status='disconnected' WHERE status='connected' AND GREATEST(last_seen_at,$1::timestamptz)<now()-interval '35 seconds' RETURNING id,name",[resumed])).rows;
 for(const n of down){
  await pool.query("INSERT INTO node_events(node_id,kind) VALUES($1,'down')",[n.id]);
  await notify(`Node ${n.name} went offline`,{node:n.name});
 }
}

/** After the panel itself was down, nodes could not report; give them a full wait from resume. */
async function engineResumedAt():Promise<Date>{
 const r=(await pool.query(`INSERT INTO settings(key,value) VALUES('failover_engine',jsonb_build_object('tickAt',now(),'resumedAt',now()))
  ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('tickAt',now(),'resumedAt',CASE WHEN (settings.value->>'tickAt')::timestamptz<now()-interval '90 seconds' THEN now() ELSE (settings.value->>'resumedAt')::timestamptz END)
  RETURNING (value->>'resumedAt')::timestamptz AS resumed`)).rows[0];
 return r.resumed as Date;
}

let running=false;
export async function sweepFailover(){
 if(running)return;running=true;
 // One API replica at a time runs the engine.
 const c=await pool.connect();
 try{
  const lock=(await c.query('SELECT pg_try_advisory_lock(727001) AS ok')).rows[0].ok;
  if(!lock)return;
  try{
   const resumed=await engineResumedAt();
   await trackNodes(resumed);
   await advanceEvents();
   const cfg=(await settings()).failover;
   if(cfg.enabled)await detectAndRecover(cfg,resumed);
   if(cfg.protectionEnabled)await protectBackups(cfg);
  }finally{await c.query('SELECT pg_advisory_unlock(727001)');}
 }finally{c.release();running=false;}
}

async function detectAndRecover(cfg:Settings,resumed:Date){
 const active=Number((await pool.query("SELECT count(*)::int AS n FROM failover_events WHERE state IN ('backing-up','restoring')")).rows[0].n);
 let room=cfg.maxConcurrent-active;
 const servers=(await pool.query(`SELECT s.*,n.location,n.name AS node_name FROM servers s JOIN nodes n ON n.id=s.node_id
  WHERE s.deleted_at IS NULL AND s.failover_enabled AND s.observed_status<>'deleting' AND n.deleted_at IS NULL AND n.status='disconnected' AND n.last_seen_at IS NOT NULL
  AND GREATEST(n.last_seen_at,$3::timestamptz)<now()-($1::int*interval '1 minute')
  AND NOT EXISTS (SELECT 1 FROM failover_events e WHERE e.server_id=s.id AND e.state IN ('backing-up','restoring'))
  AND NOT EXISTS (SELECT 1 FROM failover_events e WHERE e.server_id=s.id AND e.state='completed' AND e.finished_at>now()-($2::int*interval '1 minute'))
  ORDER BY n.last_seen_at,s.id`,[cfg.graceMinutes,cfg.cooldownMinutes,resumed])).rows;
 for(const s of servers){
  // Blocked servers are retried every sweep without counting against the limit.
  const open=(await pool.query("SELECT state FROM failover_events WHERE server_id=$1 AND state='blocked'",[s.id])).rows[0];
  if(!open&&room<=0)continue;
  const r=await startFailover(s,cfg,`${s.node_name} was offline for more than ${cfg.graceMinutes} minutes`,null);
  if(r)room--;
 }
}

/** Keeps a recent backup for servers that would otherwise be unrecoverable. */
async function protectBackups(cfg:Settings){
 if(!(await backupEnabled()))return;
 const due=(await pool.query(`SELECT s.id,s.node_id FROM servers s JOIN nodes n ON n.id=s.node_id
  WHERE s.deleted_at IS NULL AND s.failover_enabled AND NOT s.suspended AND s.desired_status='running' AND s.observed_status='running' AND n.status='connected'
  AND (n.agent->'quota'->>'enforced')='true'
  AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.server_id=s.id AND (b.state IN ('queued','running') OR (b.state='succeeded' AND b.created_at>now()-($1::int*interval '1 minute'))))
  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.server_id=s.id AND j.kind='backup' AND j.state IN ('queued','running'))
  AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.server_id=s.id AND b.state='failed' AND b.created_at>now()-interval '10 minutes')
  LIMIT 5`,[cfg.protectionIntervalMinutes])).rows;
 for(const s of due){
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const b=(await c.query('INSERT INTO backups(server_id,object_key) VALUES($1,$2) RETURNING id',[s.id,`servers/${s.id}/backups/${crypto.randomUUID()}.tar.gz`])).rows[0];
   const j=(await c.query("INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,'backup',$3) RETURNING id",[s.node_id,s.id,JSON.stringify({backupId:b.id,protection:true})])).rows[0];
   await c.query('UPDATE backups SET job_id=$1 WHERE id=$2',[j.id,b.id]);
   await c.query('COMMIT');
  }catch{await c.query('ROLLBACK').catch(()=>{});}finally{c.release();}
 }
}

/** Planned move: stop, final backup, then rebuild on another node. */
async function startMigration(server:any,actor:string,toNode:string|null){
 if(!(await backupEnabled()))fail(409,'Migration moves data through a backup, so object storage must be on');
 if(server.node_status!=='connected')fail(409,'The server’s node is offline. Use failover instead.');
 if(toNode){const t=(await pool.query("SELECT status,draining FROM nodes WHERE id=$1 AND deleted_at IS NULL",[toNode])).rows[0];if(!t||t.status!=='connected'||t.draining||toNode===server.node_id)fail(409,'The chosen node is not available');}
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const open=await c.query("SELECT 1 FROM failover_events WHERE server_id=$1 AND state IN ('backing-up','restoring')",[server.id]);
  if(open.rowCount)fail(409,'This server is already being moved');
  await c.query("DELETE FROM failover_events WHERE server_id=$1 AND state='blocked'",[server.id]);
  if(server.desired_status==='running')await c.query("INSERT INTO jobs(node_id,server_id,kind,created_at) VALUES($1,$2,'stop',clock_timestamp())",[server.node_id,server.id]);
  const b=(await c.query('INSERT INTO backups(server_id,object_key) VALUES($1,$2) RETURNING id',[server.id,`servers/${server.id}/backups/${crypto.randomUUID()}.tar.gz`])).rows[0];
  const j=(await c.query("INSERT INTO jobs(node_id,server_id,kind,payload,created_at) VALUES($1,$2,'backup',$3,clock_timestamp()) RETURNING id",[server.node_id,server.id,JSON.stringify({backupId:b.id,migration:true})])).rows[0];
  await c.query('UPDATE backups SET job_id=$1 WHERE id=$2',[j.id,b.id]);
  const ev=(await c.query("INSERT INTO failover_events(server_id,kind,state,reason,from_node,to_node,job_id,actor_id) VALUES($1,'migration','backing-up','Planned migration',$2,$3,$4,$5) RETURNING id",[server.id,server.node_id,toNode,j.id,actor])).rows[0];
  await c.query('COMMIT');
  await audit(actor,'server.migrate.start','server',server.id,{toNode});
  return ev.id as string;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}

const eventShape=(e:any)=>({id:e.id,serverId:e.server_id,serverName:e.server_name||null,kind:e.kind,state:e.state,reason:e.reason,fromNode:e.from_node,fromNodeName:e.from_name||null,toNode:e.to_node,toNodeName:e.to_name||null,backupId:e.backup_id,dataAgeSeconds:e.data_age_seconds,error:e.error,startedAt:e.started_at,finishedAt:e.finished_at});
const eventQuery=`SELECT e.*,s.name AS server_name,fn.name AS from_name,tn.name AS to_name FROM failover_events e LEFT JOIN servers s ON s.id=e.server_id LEFT JOIN nodes fn ON fn.id=e.from_node LEFT JOIN nodes tn ON tn.id=e.to_node`;

export function failoverRoutes(app:FastifyInstance){
 app.get('/api/failover/status',async(req)=>{
  admin(req);
  const cfg=(await settings()).failover,storage=await backupEnabled();
  const resumed=(await pool.query("SELECT (value->>'resumedAt')::timestamptz AS r FROM settings WHERE key='failover_engine'")).rows[0]?.r||new Date(0);
  const nodes=(await pool.query(`SELECT n.id,n.name,n.location,n.status,n.draining,n.last_seen_at,n.version,n.agent,
   EXTRACT(EPOCH FROM now()-GREATEST(n.last_seen_at,$1::timestamptz))::int AS silent_for,
   (SELECT count(*)::int FROM servers s WHERE s.node_id=n.id AND s.deleted_at IS NULL) AS servers
   FROM nodes n WHERE n.deleted_at IS NULL ORDER BY n.name`,[resumed])).rows;
  const servers=(await pool.query(`SELECT s.id,s.name,s.node_id,n.name AS node_name,s.failover_enabled,s.desired_status,s.observed_status,
   (SELECT max(b.created_at) FROM backups b WHERE b.server_id=s.id AND b.state='succeeded') AS last_backup,
   (SELECT EXTRACT(EPOCH FROM now()-max(b.created_at))::int FROM backups b WHERE b.server_id=s.id AND b.state='succeeded') AS backup_age
   FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.deleted_at IS NULL ORDER BY s.name`)).rows;
  const events=(await pool.query(`${eventQuery} ORDER BY e.started_at DESC LIMIT 40`)).rows.map(eventShape);
  const stats=(await pool.query(`SELECT count(*) FILTER (WHERE state='completed' AND started_at>now()-interval '24 hours')::int AS ok24,count(*) FILTER (WHERE state='failed' AND started_at>now()-interval '24 hours')::int AS failed24,
   coalesce(round(avg(EXTRACT(EPOCH FROM finished_at-started_at)) FILTER (WHERE state='completed' AND started_at>now()-interval '30 days'))::int,0) AS avg_recovery,
   coalesce(round(avg(data_age_seconds) FILTER (WHERE state='completed' AND data_age_seconds IS NOT NULL AND started_at>now()-interval '30 days'))::int,0) AS avg_data_age FROM failover_events`)).rows[0];
  const nodeHistory=(await pool.query("SELECT e.id,e.kind,e.at,n.name AS node_name FROM node_events e JOIN nodes n ON n.id=e.node_id ORDER BY e.at DESC LIMIT 30")).rows;
  const limit=cfg.maxBackupAgeHours*3600;
  const rows=servers.map(s=>{
   const issues:string[]=[];
   if(!s.failover_enabled)issues.push('Failover is turned off for this server');
   else if(!storage&&!cfg.allowWithoutBackup)issues.push('Object storage is off');
   else if(s.backup_age===null)issues.push(cfg.allowWithoutBackup?'No backup: would restart empty':'No backup yet');
   else if(limit>0&&s.backup_age>limit)issues.push(`Newest backup is older than ${cfg.maxBackupAgeHours} h`);
   return {id:s.id,name:s.name,nodeId:s.node_id,nodeName:s.node_name,failoverEnabled:s.failover_enabled,status:s.observed_status,lastBackupAt:s.last_backup,backupAgeSeconds:s.backup_age,protected:issues.length===0,issues};
  });
  return {
   settings:{enabled:cfg.enabled,graceMinutes:cfg.graceMinutes,maxBackupAgeHours:cfg.maxBackupAgeHours,protectionEnabled:cfg.protectionEnabled,selfFence:cfg.selfFence,webhook:!!cfg.webhookUrl},
   storageEnabled:storage,
   nodes:nodes.map(n=>({id:n.id,name:n.name,location:n.location,status:n.status,draining:n.draining,lastSeenAt:n.last_seen_at,silentForSeconds:n.silent_for,servers:n.servers,version:n.version,snapshots:!!n.agent?.quota?.enforced,
    failoverInSeconds:cfg.enabled&&n.status==='disconnected'&&n.silent_for!==null?Math.max(0,cfg.graceMinutes*60-n.silent_for):null})),
   servers:rows,
   events,nodeHistory:nodeHistory.map(h=>({id:h.id,kind:h.kind,at:h.at,nodeName:h.node_name})),
   stats:{recovered24h:stats.ok24,failed24h:stats.failed24,averageRecoverySeconds:stats.avg_recovery,averageDataAgeSeconds:stats.avg_data_age,protectedServers:rows.filter(r=>r.protected).length,totalServers:rows.length,active:events.filter(e=>ACTIVE.includes(e.state)).length},
  };
 });
 app.get('/api/failover/events',async(req)=>{admin(req);const q=req.query as any,limit=Math.min(100,Math.max(1,Number(q?.limit)||50)),offset=Math.max(0,Number(q?.offset)||0);return (await pool.query(`${eventQuery} ORDER BY e.started_at DESC LIMIT $1 OFFSET $2`,[limit,offset])).rows.map(eventShape);});
 // Dry run: what would happen if this node went down right now.
 app.post('/api/failover/plan',async(req)=>{
  admin(req);const nodeId=asId((req.body as any)?.nodeId),cfg=(await settings()).failover;
  const node=(await pool.query("SELECT id,name FROM nodes WHERE id=$1 AND deleted_at IS NULL",[nodeId])).rows[0];if(!node)fail(404,'Node not found');
  const servers=(await pool.query("SELECT s.*,n.location FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.node_id=$1 AND s.deleted_at IS NULL ORDER BY s.name",[nodeId])).rows;
  const out=[];
  for(const s of servers){
   if(!s.failover_enabled){out.push({serverId:s.id,serverName:s.name,ok:false,blockers:['Failover is turned off for this server']});continue;}
   const p=await planServer(s,cfg,[nodeId]);
   out.push({serverId:s.id,serverName:s.name,ok:p.ok,blockers:p.blockers,targetNode:p.target?.name||null,backupAgeSeconds:p.backup?.age??null});
  }
  return {node:node.name,servers:out};
 });
 app.patch('/api/servers/:id/failover',async(req)=>{
  admin(req);const id=asId((req.params as any).id),b=req.body as any;
  if(typeof b?.enabled!=='boolean')fail(400,'enabled must be true or false');
  const r=await pool.query('UPDATE servers SET failover_enabled=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id,failover_enabled',[id,b.enabled]);
  if(!r.rowCount)fail(404,'Server not found');
  await audit(req.actor!.id,'server.failover.setting','server',id,{enabled:b.enabled});
  return {id,failoverEnabled:r.rows[0].failover_enabled};
 });
 // Run failover for one server now. The node must be offline unless force is set.
 app.post('/api/servers/:id/failover',async(req)=>{
  admin(req);const id=asId((req.params as any).id),b=req.body as any,cfg=(await settings()).failover;
  const s=(await pool.query("SELECT s.*,n.status AS node_status,n.name AS node_name,n.location FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.id=$1 AND s.deleted_at IS NULL",[id])).rows[0];
  if(!s)fail(404,'Server not found');
  if(s.node_status==='connected'&&b?.force!==true)fail(409,'The node is online. Use “Move” for a planned migration, or confirm forcing a failover.');
  const plan=await planServer(s,cfg,[s.node_id]);
  if(!plan.ok)fail(409,plan.blockers.join('; '));
  const r=await moveServer(id,{kind:'failover',reason:s.node_status==='connected'?'Forced by an administrator':'Started by an administrator',actor:req.actor!.id,backup:plan.backup||null,fromNode:s.node_id});
  if(!r)fail(409,'The server changed while planning; try again');
  return {eventId:r!.eventId,toNode:r!.toName};
 });
 app.post('/api/servers/:id/migrate',async(req)=>{
  admin(req);const id=asId((req.params as any).id),b=req.body as any;
  const s=(await pool.query("SELECT s.*,n.status AS node_status FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.id=$1 AND s.deleted_at IS NULL",[id])).rows[0];
  if(!s)fail(404,'Server not found');
  const eventId=await startMigration(s,req.actor!.id,b?.nodeId?asId(b.nodeId):null);
  return {eventId};
 });
 // Move every server off a node and stop placing new ones there.
 app.post('/api/nodes/:id/evacuate',async(req)=>{
  admin(req);const id=asId((req.params as any).id);
  const n=(await pool.query("SELECT id,status FROM nodes WHERE id=$1 AND deleted_at IS NULL",[id])).rows[0];if(!n)fail(404,'Node not found');
  if(n.status!=='connected')fail(409,'The node is offline. Use failover instead.');
  await pool.query('UPDATE nodes SET draining=true WHERE id=$1',[id]);
  const servers=(await pool.query("SELECT s.*,$2::text AS node_status FROM servers s WHERE s.node_id=$1 AND s.deleted_at IS NULL ORDER BY s.name",[id,n.status])).rows;
  const started:string[]=[],skipped:{name:string;reason:string}[]=[];
  for(const s of servers){try{await startMigration(s,req.actor!.id,null);started.push(s.name);}catch(e:any){skipped.push({name:s.name,reason:e.message});}}
  await audit(req.actor!.id,'node.evacuate','node',id,{started:started.length,skipped:skipped.length});
  return {started,skipped};
 });
 app.post('/api/failover/events/:id/dismiss',async(req)=>{
  admin(req);const r=await pool.query("DELETE FROM failover_events WHERE id=$1 AND state IN ('blocked','failed') RETURNING id",[asId((req.params as any).id)]);
  if(!r.rowCount)fail(404,'Event not found or still running');return {ok:true};
 });
 app.post('/api/settings/failover/test-webhook',async(req)=>{
  admin(req);
  const url=(await settings()).failover.webhookUrl;if(!url)fail(400,'No webhook is saved');
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Fledge: test notification',content:'Fledge: test notification',event:{title:'test',at:new Date().toISOString()}}),signal:AbortSignal.timeout(6000)}).catch((e:any)=>fail(502,`Could not reach the webhook: ${e?.cause?.code||e?.message||'error'}`));
  if(!r.ok)fail(502,`The webhook answered ${r.status}`);return {ok:true};
 });
}

/** Orphaned data on a returning node: copies of servers that now live elsewhere. */
export async function staleOnNode(nodeId:string,held:string[]){
 if(!held.length)return [];
 if(!(await settings()).failover.evictStaleData)return [];
 const rows=(await pool.query(`SELECT DISTINCT e.server_id FROM failover_events e JOIN servers s ON s.id=e.server_id
  WHERE e.from_node=$1 AND e.state IN ('restoring','completed') AND e.server_id=ANY($2::uuid[]) AND s.node_id<>$1
  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.node_id=$1 AND j.kind='evict' AND j.payload->>'serverId'=e.server_id::text AND j.state IN ('queued','running'))`,[nodeId,held])).rows;
 return rows.map(r=>r.server_id as string);
}
