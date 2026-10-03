import type {FastifyInstance} from 'fastify';
import {pool,fail,enqueue,audit,serverAccess} from './core.js';
import {requireManage} from './servers.js';
import {emit} from './notifications.js';
import {getRelease} from './updates.js';

// Crash policy: when a server that should be running exits on its own, restart it with growing
// pauses; if it keeps crashing, stop trying and tell someone. Also watches disk usage.

export type CrashPolicy={mode:'off'|'on-failure'|'always';maxRestarts:number;windowMinutes:number;backoffSeconds:number[]};
export const defaultPolicy:CrashPolicy={mode:'off',maxRestarts:3,windowMinutes:10,backoffSeconds:[10,30,60]};
export function normalizePolicy(raw:any):CrashPolicy{
 const p={...defaultPolicy,...(raw&&typeof raw==='object'?raw:{})};
 return {mode:['off','on-failure','always'].includes(p.mode)?p.mode:'off',maxRestarts:Math.min(20,Math.max(1,Number(p.maxRestarts)||3)),windowMinutes:Math.min(1440,Math.max(1,Number(p.windowMinutes)||10)),
  backoffSeconds:(Array.isArray(p.backoffSeconds)&&p.backoffSeconds.length?p.backoffSeconds:defaultPolicy.backoffSeconds).slice(0,10).map((n:any)=>Math.min(3600,Math.max(5,Number(n)||10)))};
}
export function validatePolicy(b:any):CrashPolicy{
 if(!b||typeof b!=='object')fail(400,'Expected an object');
 if(!['off','on-failure','always'].includes(b.mode))fail(400,'mode must be off, on-failure or always');
 const int=(v:any,name:string,min:number,max:number)=>{const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)fail(400,`${name} must be a whole number from ${min} to ${max}`);return n;};
 const backoff=b.backoffSeconds===undefined?defaultPolicy.backoffSeconds:b.backoffSeconds;
 if(!Array.isArray(backoff)||!backoff.length||backoff.length>10)fail(400,'backoffSeconds must be 1 to 10 numbers');
 return {mode:b.mode,maxRestarts:int(b.maxRestarts??defaultPolicy.maxRestarts,'Restarts',1,20),windowMinutes:int(b.windowMinutes??defaultPolicy.windowMinutes,'Window (minutes)',1,1440),backoffSeconds:backoff.map((n:any)=>int(n,'Pause (seconds)',5,3600))};
}

async function event(serverId:string,kind:string,message:string,detail:Record<string,unknown>={}){
 await pool.query('INSERT INTO server_events(server_id,kind,message,detail) VALUES($1,$2,$3,$4)',[serverId,kind,message.slice(0,300),JSON.stringify(detail)]);
 await pool.query('DELETE FROM server_events WHERE server_id=$1 AND id<(SELECT id FROM server_events WHERE server_id=$1 ORDER BY id DESC OFFSET 199 LIMIT 1)',[serverId]).catch(()=>{});
}
const describeExit=(x:any)=>x?`exit code ${x.code}${x.oomKilled?', out of memory':''}`:'it stopped by itself';

/** Called once per sweep: restart crashed servers, notice recoveries. */
export async function sweepCrashes(){
 const rows=(await pool.query(`SELECT s.id,s.name,s.node_id,s.observed_status,s.crash_policy,s.crash_state,s.last_exit,s.suspended
  FROM servers s JOIN nodes n ON n.id=s.node_id
  WHERE s.deleted_at IS NULL AND s.desired_status='running' AND NOT s.suspended AND n.status='connected' AND s.crash_policy->>'mode' IN ('on-failure','always')
   AND (s.observed_status IN ('failed','stopped') OR s.crash_state<>'{}'::jsonb)
   AND NOT EXISTS(SELECT 1 FROM failover_events f WHERE f.server_id=s.id AND f.state IN ('blocked','backing-up','restoring'))`)).rows;
 const now=Date.now();
 for(const s of rows){
  const policy=normalizePolicy(s.crash_policy),state:any={...(s.crash_state||{})};
  const crashed=s.observed_status==='failed'||(policy.mode==='always'&&s.observed_status==='stopped');
  const save=(st:any)=>pool.query('UPDATE servers SET crash_state=$2 WHERE id=$1',[s.id,JSON.stringify(st)]);
  if(!crashed){
   if(s.observed_status==='running'){
    // A restart only counts as recovered once the server has stayed up for a couple of minutes;
    // otherwise a server that crashes right after starting would never reach the crash-loop limit.
    if(!state.runningSince){state.runningSince=new Date(now).toISOString();await save(state);}
    else if(now-Date.parse(state.runningSince)>=2*60_000&&(state.failedAt||state.restarts?.length)){
     if(state.restarts?.length){await event(s.id,'recovered','The server is running again');await emit({kind:'server.recovered',title:`${s.name} is running again`,serverId:s.id});}
     await save({});
    }
   }
   continue;
  }
  if(state.runningSince){delete state.runningSince;}
  if(state.loop)continue;
  // Anything already queued for this server (a start, a restore ...) is allowed to finish first.
  if((await pool.query("SELECT 1 FROM jobs WHERE server_id=$1 AND state IN ('queued','running') LIMIT 1",[s.id])).rowCount)continue;
  if(!state.failedAt){
   state.failedAt=new Date(now).toISOString();
   await save(state);
   const why=describeExit(s.last_exit);
   await event(s.id,'crash',`The server stopped unexpectedly (${why})`,{exit:s.last_exit||null});
   await emit({kind:'server.crashed',title:`${s.name} crashed`,body:`${why}${s.last_exit?.logTail?`\n\n${String(s.last_exit.logTail).slice(-600)}`:''}`,serverId:s.id,data:{exit:s.last_exit||null}});
  }
  const windowStart=now-policy.windowMinutes*60_000;
  const recent=(state.restarts as string[]||[]).filter(t=>Date.parse(t)>=windowStart);
  if(recent.length>=policy.maxRestarts){
   state.loop=true;state.restarts=recent;
   await save(state);
   await event(s.id,'crashloop',`The server crashed ${recent.length} times in ${policy.windowMinutes} minutes; automatic restarts stopped`);
   await emit({kind:'server.crashloop',title:`${s.name} keeps crashing`,body:`It crashed ${recent.length} times in ${policy.windowMinutes} minutes, so automatic restarts were stopped. Check the console, then start it by hand.`,serverId:s.id});
   continue;
  }
  const wait=policy.backoffSeconds[Math.min(recent.length,policy.backoffSeconds.length-1)]*1000;
  if(now<Date.parse(state.failedAt)+wait)continue;
  try{
   await enqueue(s.node_id,s.id,'start');
   state.restarts=[...recent,new Date(now).toISOString()];state.failedAt=null;
   await save(state);
   await event(s.id,'restart',`Restarting automatically (attempt ${state.restarts.length} of ${policy.maxRestarts} in ${policy.windowMinutes} minutes)`);
  }catch(e){console.error('Could not restart a crashed server:',(e as Error)?.message);}
 }
}

/** Disk space warnings and the "new version available" notice. */
export async function sweepAlerts(){
 const rows=(await pool.query("SELECT id,name,disk_mb,usage,alert_state FROM servers WHERE deleted_at IS NULL AND observed_status='running' AND (usage->>'diskBytes') IS NOT NULL")).rows;
 for(const s of rows){
  const used=Number(s.usage.diskBytes),ratio=used/(s.disk_mb*1048576),state:any={...(s.alert_state||{})};
  if(ratio>=0.9&&!state.diskHigh){
   await emit({kind:'server.disk_high',title:`${s.name} is almost out of disk space`,body:`${Math.round(ratio*100)}% of its ${s.disk_mb} MB is used.`,serverId:s.id,dedupe:{key:`disk:${s.id}`,minutes:360}});
   state.diskHigh=true;await pool.query('UPDATE servers SET alert_state=$2 WHERE id=$1',[s.id,JSON.stringify(state)]);
  }else if(ratio<0.8&&state.diskHigh){
   delete state.diskHigh;await pool.query('UPDATE servers SET alert_state=$2 WHERE id=$1',[s.id,JSON.stringify(state)]);
  }
 }
 try{
  const rel=await getRelease(false);
  if(rel.updateAvailable&&rel.latestVersion){
   await emit({kind:'update.available',title:`Fledge ${rel.latestVersion} is available`,body:'Open Updates to install it.',dedupe:{key:`update:${rel.latestVersion}`,minutes:60*24*365}});
  }
 }catch{/* offline or rate-limited: try again next time */}
}

export function crashRoutes(app:FastifyInstance){
 app.get('/api/servers/:id/crash-policy',async(req)=>{
  const s=await serverAccess(req,(req.params as any).id);
  const st:any=s.crash_state||{};
  return {policy:normalizePolicy(s.crash_policy),loop:!!st.loop,restartsInWindow:(st.restarts||[]).length,lastExit:s.last_exit||null};
 });
 app.put('/api/servers/:id/crash-policy',async(req)=>{
  const s=await requireManage(req,(req.params as any).id),p=validatePolicy(req.body);
  await pool.query("UPDATE servers SET crash_policy=$2,crash_state='{}'::jsonb WHERE id=$1",[s.id,JSON.stringify(p)]);
  await audit(req.actor!.id,'server.crash_policy','server',s.id,{mode:p.mode});
  return {policy:p,loop:false,restartsInWindow:0,lastExit:s.last_exit||null};
 });
 app.get('/api/servers/:id/events',async(req)=>{
  const s=await serverAccess(req,(req.params as any).id),limit=Math.min(100,Math.max(1,Number((req.query as any)?.limit)||30));
  return (await pool.query('SELECT id,kind,message,detail,at FROM server_events WHERE server_id=$1 ORDER BY id DESC LIMIT $2',[s.id,limit])).rows.map((r:any)=>({...r,id:Number(r.id)}));
 });
}
