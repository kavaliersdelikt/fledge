import type {FastifyInstance} from 'fastify';
import {CronExpressionParser} from 'cron-parser';
import {pool,fail,txt,asId,enqueue,audit,serverAccess} from './core.js';
import {backupEnabled} from './storage.js';
import {active,requireManage} from './servers.js';
import {enforceQuota} from './quota.js';
import {requireFlag} from './limits.js';
import {emit} from './notifications.js';

// Schedules: cron or interval triggers that run a chain of tasks on a server (power actions,
// console commands, backups, waits). A run is a small state machine stored in the database, so
// it survives restarts and works with several API replicas. Steps that queue work for the node
// rely on the per-server job order: a backup queued before a restart finishes before it.

export type Task={action:'power';power:'start'|'stop'|'restart'|'kill'}|{action:'command';command:string}|{action:'backup'}|{action:'wait';seconds:number};
const MAX_STEPS=20,MAX_SCHEDULES=20,MIN_GAP_MS=5*60_000;

export function validTimezone(tz:string){try{new Intl.DateTimeFormat('en',{timeZone:tz});return true;}catch{return false;}}

/** Next occurrences of a 5-field cron expression. Throws a plain Error with a readable message. */
export function cronNext(expr:string,tz:string,from:Date,count=1):Date[]{
 if(expr.trim().split(/\s+/).length!==5)throw new Error('Use five fields: minute hour day-of-month month day-of-week');
 const it=CronExpressionParser.parse(expr.trim(),{tz,currentDate:from});
 const out:Date[]=[];
 for(let i=0;i<count;i++)out.push(it.next().toDate());
 return out;
}
export function checkCron(expr:string,tz:string){
 if(!validTimezone(tz))fail(400,`“${tz.slice(0,40)}” is not a known time zone (use names like Europe/Berlin or UTC)`);
 let runs:Date[];
 try{runs=cronNext(expr,tz,new Date(),8);}catch(e:any){return fail(400,`That is not a valid schedule: ${String(e?.message||'').slice(0,120)}`);}
 for(let i=1;i<runs.length;i++)if(runs[i].getTime()-runs[i-1].getTime()<MIN_GAP_MS)fail(400,'A schedule can run at most every 5 minutes');
}

export function validateTasks(raw:unknown):Task[]{
 if(!Array.isArray(raw)||!raw.length||raw.length>MAX_STEPS)fail(400,`A schedule needs between 1 and ${MAX_STEPS} steps`);
 const out:Task[]=[];let wait=0;
 for(const t of raw as any[]){
  switch(t?.action){
   case 'power':
    if(!['start','stop','restart','kill'].includes(t.power))fail(400,'A power step must be start, stop, restart or kill');
    out.push({action:'power',power:t.power});break;
   case 'command':{
    const c=txt(t.command,1024);
    if(/[\r\n\0]/.test(c))fail(400,'A command must be a single line');
    out.push({action:'command',command:c});break;}
   case 'backup':out.push({action:'backup'});break;
   case 'wait':{
    const n=Number(t.seconds);
    if(!Number.isInteger(n)||n<1||n>3600)fail(400,'A wait step must be 1 to 3600 seconds');
    wait+=n;out.push({action:'wait',seconds:n});break;}
   default:fail(400,'Unknown step type (power, command, backup or wait)');
  }
 }
 if(wait>6*3600)fail(400,'The waits in one schedule may add up to at most 6 hours');
 return out;
}

/** Tasks of a schedule row, including the older single-action kinds. */
export function tasksOf(row:{kind:string;command?:string|null;tasks?:any}):Task[]{
 if(Array.isArray(row.tasks)&&row.tasks.length)return row.tasks;
 if(row.kind==='backup')return [{action:'backup'}];
 if(row.kind==='command'&&row.command)return [{action:'command',command:row.command}];
 return [];
}
function nextRun(row:{cron:string|null;timezone:string;interval_minutes:number},from=new Date()):Date{
 if(row.cron)return cronNext(row.cron,row.timezone||'UTC',from,1)[0];
 return new Date(from.getTime()+Math.max(5,row.interval_minutes)*60_000);
}
const shape=(r:any)=>({id:r.id,name:r.name||null,kind:r.kind,cron:r.cron,intervalMinutes:r.interval_minutes||null,timezone:r.timezone,tasks:tasksOf(r),missed:r.missed,enabled:r.enabled,nextRunAt:r.next_run_at,lastRunAt:r.last_run_at,lastStatus:r.last_status,lastError:r.last_error,createdAt:r.created_at,
 command:r.kind==='command'?r.command:undefined});

// --- Running -------------------------------------------------------------------------------------
async function execStep(server:any,task:Task):Promise<string>{
 if(!server||server.deleted_at||server.observed_status==='deleting')throw new Error('The server no longer exists');
 if(server.suspended&&!(task.action==='power'&&(task.power==='stop'||task.power==='kill')))throw new Error('The server is suspended');
 if(server.node_status!=='connected')throw new Error('The server’s node is offline');
 switch(task.action){
  case 'power':{
   await enqueue(server.node_id,server.id,task.power);
   await pool.query('UPDATE servers SET desired_status=$1,crash_state=\'{}\'::jsonb WHERE id=$2',[task.power==='stop'||task.power==='kill'?'stopped':'running',server.id]);
   return `${task.power} queued`;
  }
  case 'command':await enqueue(server.node_id,server.id,'command',{command:task.command});return 'command sent';
  case 'backup':{
   if(!(await backupEnabled()))throw new Error('Backups need object storage (turned off)');
   await enforceQuota(server.owner_id,{backups:1,backupMb:1},{change:{backupsOnServer:Number((await pool.query("SELECT count(*) n FROM backups WHERE server_id=$1 AND state<>'failed'",[server.id])).rows[0].n)}});
   const c=await pool.connect();
   try{
    await c.query('BEGIN');
    const b=(await c.query('INSERT INTO backups(server_id,object_key) VALUES($1,$2) RETURNING id',[server.id,`servers/${server.id}/backups/${crypto.randomUUID()}.tar.gz`])).rows[0];
    const j=(await c.query("INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,'backup',$3) RETURNING id",[server.node_id,server.id,JSON.stringify({backupId:b.id})])).rows[0];
    await c.query('UPDATE backups SET job_id=$1 WHERE id=$2',[j.id,b.id]);
    await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
   return 'backup queued';
  }
  default:return 'waited';
 }
}

async function finish(run:any,state:'succeeded'|'failed'|'skipped',error:string|null,results:any[]){
 await pool.query('UPDATE schedule_runs SET state=$2,error=$3,results=$4,finished_at=now(),next_step_at=NULL WHERE id=$1',[run.id,state,error,JSON.stringify(results)]);
 const prev=(await pool.query('UPDATE schedules SET last_run_at=now(),last_status=$2,last_error=$3 WHERE id=$1 RETURNING name,kind',[run.schedule_id,state,error])).rows[0];
 if(state==='failed')await emit({kind:'schedule.failed',title:`Scheduled task “${prev?.name||prev?.kind||'schedule'}” failed`,body:error||'',serverId:run.server_id,data:{scheduleId:run.schedule_id,runId:run.id},dedupe:{key:run.schedule_id,minutes:360}});
}

/** Moves a run forward: executes steps until it has to wait or is finished. */
async function advance(run:any){
 const sc=(await pool.query('SELECT * FROM schedules WHERE id=$1',[run.schedule_id])).rows[0];
 const tasks=sc?tasksOf(sc):[];
 const results:any[]=Array.isArray(run.results)?[...run.results]:[];
 let step=run.step;
 const server=(await pool.query('SELECT s.*,n.status AS node_status FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.id=$1',[run.server_id])).rows[0];
 for(let guard=0;guard<MAX_STEPS+1;guard++){
  const task=tasks[step];
  if(!task){await finish(run,'succeeded',null,results);return;}
  if(task.action==='wait'){
   results.push({step,action:'wait',seconds:task.seconds,at:new Date().toISOString(),ok:true});
   await pool.query("UPDATE schedule_runs SET step=$2,results=$3,next_step_at=now()+make_interval(secs=>$4::int) WHERE id=$1",[run.id,step+1,JSON.stringify(results),task.seconds]);
   return;
  }
  try{
   const detail=await execStep(server,task);
   results.push({step,action:task.action,at:new Date().toISOString(),ok:true,detail});
  }catch(e:any){
   const message=String(e?.message||'failed').slice(0,300);
   results.push({step,action:task.action,at:new Date().toISOString(),ok:false,detail:message});
   await finish(run,'failed',`Step ${step+1} (${task.action}): ${message}`,results);return;
  }
  step++;
 }
 await finish(run,'succeeded',null,results);
}

export async function sweepAutomation(){
 // 1) Start runs for schedules that are due.
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const due=(await c.query("SELECT sc.* FROM schedules sc JOIN servers s ON s.id=sc.server_id WHERE sc.enabled AND sc.next_run_at<=now() AND s.deleted_at IS NULL FOR UPDATE OF sc SKIP LOCKED LIMIT 50")).rows;
  for(const sc of due){
   let next:Date;
   try{next=nextRun(sc);}catch{await c.query('UPDATE schedules SET enabled=false,last_status=\'failed\',last_error=\'The schedule could not be calculated and was turned off\' WHERE id=$1',[sc.id]);continue;}
   const late=Date.now()-new Date(sc.next_run_at).getTime()>5*60_000;
   await c.query('UPDATE schedules SET next_run_at=$2 WHERE id=$1',[sc.id,next]);
   if(late&&sc.missed==='skip'){
    await c.query("INSERT INTO schedule_runs(schedule_id,server_id,state,error,finished_at) VALUES($1,$2,'skipped','Missed while the panel was unavailable',now())",[sc.id,sc.server_id]);
    await c.query("UPDATE schedules SET last_status='skipped',last_error='Missed while the panel was unavailable' WHERE id=$1",[sc.id]);
    continue;
   }
   const started=await c.query("INSERT INTO schedule_runs(schedule_id,server_id,state,next_step_at) VALUES($1,$2,'running',now()) ON CONFLICT(schedule_id) WHERE state='running' DO NOTHING RETURNING id",[sc.id,sc.server_id]);
   if(!started.rowCount){
    await c.query("INSERT INTO schedule_runs(schedule_id,server_id,state,error,finished_at) VALUES($1,$2,'skipped','The previous run was still in progress',now())",[sc.id,sc.server_id]);
    await c.query("UPDATE schedules SET last_status='skipped',last_error='The previous run was still in progress' WHERE id=$1",[sc.id]);
   }
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 // 2) Move running runs forward. Claiming a run pushes its next step 90 seconds out, which doubles as a
 //    lease: if this process dies mid-run, another replica picks the run up once the lease expires.
 const runs=(await pool.query("UPDATE schedule_runs SET next_step_at=now()+interval '90 seconds' WHERE id IN (SELECT id FROM schedule_runs WHERE state='running' AND next_step_at<=now() ORDER BY next_step_at FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING *")).rows;
 for(const run of runs)await advance(run).catch(async e=>{await finish(run,'failed',String(e?.message||'failed').slice(0,300),run.results||[]).catch(()=>{});});
 // Old runs are kept for a while, then dropped.
 await pool.query("DELETE FROM schedule_runs WHERE finished_at<now()-interval '30 days'");
}

// --- Routes --------------------------------------------------------------------------------------
async function parseSchedule(b:any,existing?:any){
 const out:any={};
 const timezone=b?.timezone!==undefined?txt(b.timezone,64):(existing?.timezone||'UTC');
 const hasCron=b?.cron!==undefined?!!b.cron:!!existing?.cron;
 let cron:string|null=existing?.cron??null,interval:number=existing?.interval_minutes||0;
 if(b?.cron!==undefined||b?.intervalMinutes!==undefined){
  if(b.cron){cron=txt(b.cron,100);interval=0;}
  else if(b.intervalMinutes!==undefined){
   const n=Number(b.intervalMinutes);
   if(!Number.isInteger(n)||n<5||n>10080)fail(400,'The interval must be 5 to 10080 minutes');
   interval=n;cron=null;
  }
 }
 if(!existing&&!cron&&!interval)fail(400,'Give either a cron expression or an interval in minutes');
 if(cron)checkCron(cron,timezone);
 void hasCron;
 let tasks:Task[]|undefined=undefined;
 if(b?.tasks!==undefined)tasks=validateTasks(b.tasks);
 else if(!existing){
  if(b?.kind==='backup')tasks=[{action:'backup'}];
  else if(b?.kind==='command')tasks=validateTasks([{action:'command',command:b.command}]);
  else fail(400,'Give the steps to run (tasks)');
 }
 out.name=b?.name!==undefined?(b.name===null||b.name===''?null:txt(b.name,60)):(existing?.name??null);
 out.cron=cron;out.interval=interval;out.timezone=timezone;out.tasks=tasks;
 out.missed=b?.missed!==undefined?(['skip','run'].includes(b.missed)?b.missed:fail(400,'missed must be skip or run')):(existing?.missed||'skip');
 out.enabled=typeof b?.enabled==='boolean'?b.enabled:(existing?.enabled??true);
 return out;
}

export function automationRoutes(app:FastifyInstance){
 app.get('/api/cron/preview',async(req)=>{
  const q=req.query as any,tz=typeof q?.tz==='string'&&q.tz?q.tz:'UTC';
  const expr=txt(q?.expr,100);
  checkCron(expr,tz);
  return {next:cronNext(expr,tz,new Date(),5).map(d=>d.toISOString())};
 });
 app.get('/api/servers/:id/schedules',async(req)=>{
  const s=await requireManage(req,(req.params as any).id);
  return (await pool.query('SELECT * FROM schedules WHERE server_id=$1 ORDER BY created_at',[s.id])).rows.map(shape);
 });
 app.post('/api/servers/:id/schedules',async(req)=>{
  const s=await requireManage(req,(req.params as any).id),p=await parseSchedule(req.body);
  const n=(await pool.query('SELECT count(*)::int n FROM schedules WHERE server_id=$1',[s.id])).rows[0].n;
  if(n>=MAX_SCHEDULES)fail(409,`A server can have at most ${MAX_SCHEDULES} schedules`);
  await requireFlag(s.owner_id,'schedules','Scheduled tasks are not part of your plan.',{actorIsAdmin:req.actor!.role==='admin'});
  await enforceQuota(s.owner_id,{},{actorIsAdmin:req.actor!.role==='admin',change:{schedulesOnServer:n}});
  const tasks=p.tasks as Task[];
  if(tasks.some(t=>t.action==='backup')&&!(await backupEnabled()))fail(503,'Backups need object storage — an administrator can turn it on in Settings');
  const kind=tasks.length===1&&tasks[0].action==='backup'&&!p.cron?'backup':tasks.length===1&&tasks[0].action==='command'&&!p.cron?'command':'chain';
  const command=kind==='command'?(tasks[0] as any).command:null;
  const at=nextRun({cron:p.cron,timezone:p.timezone,interval_minutes:p.interval});
  const row=(await pool.query('INSERT INTO schedules(server_id,kind,command,interval_minutes,next_run_at,enabled,name,cron,timezone,tasks,missed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
   [s.id,kind,command,p.interval,at,p.enabled,p.name,p.cron,p.timezone,kind==='chain'?JSON.stringify(tasks):'[]',p.missed])).rows[0];
  await audit(req.actor!.id,'schedule.create','server',s.id,{schedule:row.id,steps:tasks.length});
  return shape(row);
 });
 app.patch('/api/servers/:id/schedules/:scheduleId',async(req)=>{
  const s=await requireManage(req,(req.params as any).id),id=asId((req.params as any).scheduleId);
  const cur=(await pool.query('SELECT * FROM schedules WHERE id=$1 AND server_id=$2',[id,s.id])).rows[0];
  if(!cur)fail(404,'Schedule not found');
  const p=await parseSchedule(req.body,cur);
  const tasks:Task[]=p.tasks||tasksOf(cur);
  if(tasks.some(t=>t.action==='backup')&&!(await backupEnabled()))fail(503,'Backups need object storage — an administrator can turn it on in Settings');
  const kind=p.tasks?'chain':cur.kind;
  const at=(b=>b.cron!==cur.cron||b.interval!==cur.interval_minutes||b.timezone!==cur.timezone||(p.enabled&&!cur.enabled))({cron:p.cron,interval:p.interval,timezone:p.timezone})?nextRun({cron:p.cron,timezone:p.timezone,interval_minutes:p.interval}):cur.next_run_at;
  const row=(await pool.query('UPDATE schedules SET name=$2,cron=$3,interval_minutes=$4,timezone=$5,tasks=$6,kind=$7,command=CASE WHEN $7=\'command\' THEN command ELSE NULL END,missed=$8,enabled=$9,next_run_at=$10 WHERE id=$1 RETURNING *',
   [id,p.name,p.cron,p.interval,p.timezone,JSON.stringify(p.tasks||cur.tasks||[]),kind,p.missed,p.enabled,at])).rows[0];
  await audit(req.actor!.id,'schedule.update','server',s.id,{schedule:id});
  return shape(row);
 });
 app.delete('/api/servers/:id/schedules/:scheduleId',async(req)=>{
  const s=await requireManage(req,(req.params as any).id);
  const r=await pool.query('DELETE FROM schedules WHERE id=$1 AND server_id=$2 RETURNING id',[asId((req.params as any).scheduleId),s.id]);
  if(!r.rowCount)fail(404,'Schedule not found');
  await audit(req.actor!.id,'schedule.delete','server',s.id,{schedule:(req.params as any).scheduleId});
  return {ok:true};
 });
 app.post('/api/servers/:id/schedules/:scheduleId/run',async(req)=>{
  const s=active(await requireManage(req,(req.params as any).id)),id=asId((req.params as any).scheduleId);
  const sc=(await pool.query('SELECT * FROM schedules WHERE id=$1 AND server_id=$2',[id,s.id])).rows[0];
  if(!sc)fail(404,'Schedule not found');
  const run=(await pool.query("INSERT INTO schedule_runs(schedule_id,server_id,state,next_step_at,trigger) VALUES($1,$2,'running',now(),'manual') ON CONFLICT(schedule_id) WHERE state='running' DO NOTHING RETURNING id",[id,s.id])).rows[0];
  if(!run)fail(409,'This schedule is already running');
  await audit(req.actor!.id,'schedule.run','server',s.id,{schedule:id});
  return {runId:run.id};
 });
 app.get('/api/servers/:id/schedules/:scheduleId/runs',async(req)=>{
  const s=await requireManage(req,(req.params as any).id),id=asId((req.params as any).scheduleId);
  const limit=Math.min(50,Math.max(1,Number((req.query as any)?.limit)||15));
  return (await pool.query('SELECT id,state,step,error,results,trigger,started_at AS "startedAt",finished_at AS "finishedAt" FROM schedule_runs WHERE schedule_id=$1 AND server_id=$2 ORDER BY started_at DESC LIMIT $3',[id,s.id,limit])).rows;
 });
}
void serverAccess;
