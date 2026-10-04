import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,asId,audit} from './core.js';
import {settings} from './settings.js';
import {LIMIT_NUMBERS,LIMIT_FLAGS,fromStorage,type LimitSet,type LimitNumber,type LimitFlag} from './rookery-settings.js';
import {notifyUser} from './notifications.js';

// Limits v2. A limit set is resolved from three layers (panel defaults, the customer's account
// plans, the customer's own override) and checked wherever something is created or resized.
// Everything here can be switched off in Settings, Limits, or set to "warn" instead of "block".

type Db={query:(q:string,a?:any[])=>Promise<any>};
export type Source='default'|'plan'|'override'|'none';
export type Resolved={values:LimitSet;sources:Record<string,{source:Source;plans?:string[]}>};
export type Usage={servers:number;runningServers:number;memoryMb:number;cpuPercent:number;diskMb:number;backups:number;backupStorageMb:number;extraPorts:number};

/** Fields whose plan values add up to the customer's total. */
export const ADDITIVE:LimitNumber[]=['servers','runningServers','memoryMb','cpuPercent','diskMb','backups','backupStorageMb','extraPorts'];
/** Fields where the most generous layer wins. */
export const MAXIMA:LimitNumber[]=['maxServerMemoryMb','maxServerCpuPercent','maxServerDiskMb','backupsPerServer','collaboratorsPerServer','schedulesPerServer'];
export const LABELS:Record<string,string>={servers:'servers',runningServers:'running servers',memoryMb:'memory (MB)',cpuPercent:'CPU (%)',diskMb:'disk (MB)',maxServerMemoryMb:'memory per server (MB)',maxServerCpuPercent:'CPU per server (%)',maxServerDiskMb:'disk per server (MB)',
 backups:'backups',backupsPerServer:'backups per server',backupStorageMb:'backup storage (MB)',extraPorts:'extra ports',collaboratorsPerServer:'collaborators per server',schedulesPerServer:'schedules per server'};

const has=(o:any,k:string)=>Object.prototype.hasOwnProperty.call(o,k);

/** Pure: combines the layers. Exported for tests. */
export function combine(defaults:LimitSet,plans:{name:string;limits:LimitSet}[],override:LimitSet|null):Resolved{
 const values:any={},sources:Record<string,{source:Source;plans?:string[]}>={};
 const d:any=defaults||{};
 const set=(k:string,v:any,source:Source,names?:string[])=>{if(v!==undefined)values[k]=v;sources[k]={source,...(names?.length?{plans:names}:{})};};
 for(const k of ADDITIVE){
  const defining=plans.filter(p=>has(p.limits,k));
  if(d[k]===null)set(k,null,'default');
  else if(!defining.length)d[k]===undefined?set(k,undefined,'none'):set(k,d[k],'default');
  else if(defining.some(p=>(p.limits as any)[k]===null))set(k,null,'plan',defining.map(p=>p.name));
  else set(k,(d[k]??0)+defining.reduce((n,p)=>n+Number((p.limits as any)[k]),0),'plan',defining.map(p=>p.name));
 }
 for(const k of MAXIMA){
  const defining=plans.filter(p=>has(p.limits,k));
  const layers=[...(d[k]!==undefined?[d[k]]:[]),...defining.map(p=>(p.limits as any)[k])];
  if(!layers.length)set(k,undefined,'none');
  else if(layers.includes(null))set(k,null,defining.length&&d[k]!==null?'plan':'default',defining.map(p=>p.name));
  else{const top=Math.max(...layers);set(k,top,defining.length&&(d[k]===undefined||top>d[k])?'plan':'default',defining.map(p=>p.name));}
 }
 for(const k of ['allowedTemplates','allowedLocations']){
  const defining=plans.filter(p=>has(p.limits,k));
  if(d[k]===null)set(k,null,'default');
  else if(!defining.length)d[k]===undefined?set(k,undefined,'none'):set(k,d[k],'default');
  else if(defining.some(p=>(p.limits as any)[k]===null))set(k,null,'plan',defining.map(p=>p.name));
  else set(k,[...new Set([...(d[k]||[]),...defining.flatMap(p=>(p.limits as any)[k]||[])])],'plan',defining.map(p=>p.name));
 }
 for(const k of LIMIT_FLAGS){
  const defining=plans.filter(p=>has(p.limits,k));
  const vals=[...(d[k]!==undefined?[d[k]]:[]),...defining.map(p=>(p.limits as any)[k])];
  if(!vals.length)set(k,undefined,'none');
  else set(k,vals.some(Boolean),defining.some(p=>(p.limits as any)[k])&&!d[k]?'plan':'default',defining.map(p=>p.name));
 }
 if(override)for(const [k,v] of Object.entries(override)){values[k]=v;sources[k]={source:'override'};}
 return {values,sources};
}

export async function resolveLimits(userId:string,db:Db=pool,lock=false):Promise<Resolved&{planGrants:LimitFlag[];enabled:boolean;mode:'enforce'|'warn'}>{
 const cfg=(await settings()).limits;
 const quota=(await db.query('SELECT quota FROM users WHERE id=$1'+(lock?' FOR UPDATE':''),[userId])).rows[0]?.quota;
 const plans=(await db.query("SELECT p.name,p.limits FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND p.kind='account' AND s.status IN ('trialing','active','past_due')",[userId])).rows.map((r:any)=>({name:r.name as string,limits:fromStorage(r.limits)}));
 const r=combine(fromStorage(cfg.defaults),plans,cfg.allowOverrides?fromStorage(quota):null);
 const planGrants=LIMIT_FLAGS.filter(flag=>plans.some((plan:any)=>plan.limits[flag]===true));
 return {...r,planGrants,enabled:cfg.enabled,mode:cfg.mode};
}

export async function usageOf(ownerId:string,db:Db=pool,excludeServerId?:string):Promise<Usage>{
 const cfg=(await settings()).limits;
 const s=(await db.query(`SELECT count(*)::int servers,
   count(*) FILTER (WHERE desired_status='running' AND NOT suspended)::int running,
   coalesce(sum(memory_mb),0)::int mem,coalesce(sum(cpu_percent),0)::int cpu,coalesce(sum(disk_mb),0)::int disk,coalesce(sum(jsonb_array_length(extra_ports)),0)::int ports
   FROM servers WHERE owner_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id<>$2) AND ($3::boolean OR subscription_id IS NULL)`,[ownerId,excludeServerId||null,cfg.countPlanServers])).rows[0];
 const b=(await db.query("SELECT count(*)::int n,coalesce(sum(b.size_bytes),0)::bigint bytes FROM backups b JOIN servers s ON s.id=b.server_id WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND b.state<>'failed'",[ownerId])).rows[0];
 return {servers:s.servers,runningServers:s.running,memoryMb:s.mem,cpuPercent:s.cpu,diskMb:s.disk,backups:b.n,backupStorageMb:Math.ceil(Number(b.bytes)/1048576),extraPorts:s.ports};
}

export type Change={servers?:number;running?:number;memoryMb?:number;cpuPercent?:number;diskMb?:number;backups?:number;backupMb?:number;extraPorts?:number;
 /** A single server's size, checked against the per-server maxima. */
 server?:{memoryMb:number;cpuPercent:number;diskMb:number};
 templateId?:string;location?:string;
 /** Current counts on one server, for the per-server caps (the change adds one). */
 backupsOnServer?:number;collaboratorsOnServer?:number;schedulesOnServer?:number};
export type CheckOptions={db?:Db;excludeServerId?:string;force?:boolean;actorIsAdmin?:boolean;planBacked?:boolean;owner?:string};

const over=(label:string,limit:number,used:number,add:number)=>`This would exceed the limit of ${limit} ${label} (${used} in use${add?`, ${add} requested`:''}).`;

/** Pure: the first limit this change would break, or null. */
export function problemOf(r:Resolved,usage:Usage,c:Change):{message:string;limit:string}|null{
 const v:any=r.values;
 const cap=(k:LimitNumber,used:number,add:number|undefined)=>{const l=v[k];if(l===undefined||l===null||!add||add<=0)return null;return used+add>l?{message:over(LABELS[k],l,used,add),limit:k}:null;};
 const checks:(({message:string;limit:string})|null)[]=[
  cap('servers',usage.servers,c.servers),cap('runningServers',usage.runningServers,c.running),cap('memoryMb',usage.memoryMb,c.memoryMb),cap('cpuPercent',usage.cpuPercent,c.cpuPercent),cap('diskMb',usage.diskMb,c.diskMb),
  cap('backups',usage.backups,c.backups),cap('backupStorageMb',usage.backupStorageMb,c.backupMb),cap('extraPorts',usage.extraPorts,c.extraPorts),
 ];
 if(c.server){
  const m=(k:LimitNumber,val:number)=>v[k]!==undefined&&v[k]!==null&&val>v[k]?{message:`A single server may use at most ${v[k]} ${LABELS[k].replace(/ per server/,'')} on your plan (${val} requested).`,limit:k}:null;
  checks.push(m('maxServerMemoryMb',c.server.memoryMb),m('maxServerCpuPercent',c.server.cpuPercent),m('maxServerDiskMb',c.server.diskMb));
 }
 const per=(k:LimitNumber,have:number|undefined)=>have!==undefined&&v[k]!==undefined&&v[k]!==null&&have+1>v[k]?{message:`This server may have at most ${v[k]} ${LABELS[k].replace(/ per server/,'')}.`,limit:k}:null;
 checks.push(per('backupsPerServer',c.backupsOnServer),per('collaboratorsPerServer',c.collaboratorsOnServer),per('schedulesPerServer',c.schedulesOnServer));
 if(c.templateId&&Array.isArray(v.allowedTemplates)&&!v.allowedTemplates.includes(c.templateId))checks.push({message:'Your plan does not include this kind of server.',limit:'allowedTemplates'});
 if(c.location&&Array.isArray(v.allowedLocations)&&!v.allowedLocations.includes(c.location))checks.push({message:'Your plan does not include this location.',limit:'allowedLocations'});
 return checks.find(Boolean)||null;
}

/**
 * Throws 409 `limit_exceeded` when a limit would be broken (in "enforce" mode). In "warn" mode the
 * change goes through and the customer and the administrators are told. Inside a transaction the
 * owner row is locked, so concurrent creates for one customer are checked one after another.
 */
export async function checkLimits(ownerId:string,change:Change,opts:CheckOptions={}):Promise<{warned:boolean;message?:string}>{
 if(opts.planBacked)return {warned:false};
 const cfg=(await settings()).limits;
 if(!cfg.enabled)return {warned:false};
 if(opts.actorIsAdmin&&(opts.force||cfg.adminOverride==='always'))return {warned:false};
 if(opts.force)return {warned:false};
 const db=opts.db||pool;
 const r=await resolveLimits(ownerId,db,!!opts.db);
 const problem=problemOf(r,await usageOf(ownerId,db,opts.excludeServerId),change);
 if(!problem)return {warned:false};
 if(cfg.mode==='warn'){
  void noteExceeded(ownerId,problem).catch(()=>{});
  return {warned:true,message:problem.message};
 }
 throw Object.assign(new Error(problem.message),{statusCode:409,error:'limit_exceeded',details:{limit:problem.limit}});
}

async function noteExceeded(ownerId:string,problem:{message:string;limit:string}){
 const cfg=(await settings()).limits;
 await audit(null,'limit.exceeded','user',ownerId,{limit:problem.limit,message:problem.message,mode:cfg.mode});
 if(cfg.notifyCustomer)await notifyUser(ownerId,{kind:'limit.exceeded',severity:'warn',title:'You are over a limit',body:problem.message,dedupe:{key:`${ownerId}:${problem.limit}`,minutes:360}});
 await notifyUser(null,{kind:'limit.exceeded',severity:'warn',title:'A customer went over a limit',body:problem.message,data:{userId:ownerId,limit:problem.limit},dedupe:{key:`admin:${ownerId}:${problem.limit}`,minutes:360}});
}

/** A flag such as "customers may use SFTP". Absent means allowed. */
export async function flagAllowed(ownerId:string,flag:LimitFlag,opts:{actorIsAdmin?:boolean;db?:Db}={}):Promise<boolean>{
 const cfg=(await settings()).limits;
 if(!cfg.enabled||cfg.mode==='warn'||(opts.actorIsAdmin&&cfg.adminOverride==='always'))return true;
 const r=await resolveLimits(ownerId,opts.db||pool);
 return (r.values as any)[flag]!==false;
}
export async function requireFlag(ownerId:string,flag:LimitFlag,message:string,opts:{actorIsAdmin?:boolean;db?:Db}={}){
 if(!await flagAllowed(ownerId,flag,opts))throw Object.assign(new Error(message),{statusCode:403,error:'not_in_plan'});
}

export async function allowedLocations(ownerId:string):Promise<string[]|null>{
 const cfg=(await settings()).limits;
 if(!cfg.enabled||cfg.mode==='warn')return null;
 const v=(await resolveLimits(ownerId)).values.allowedLocations;
 return Array.isArray(v)?v:null;
}

/** What the explain view and the customer's usage card show. */
export async function limitsView(userId:string){
 const r=await resolveLimits(userId),usage=await usageOf(userId);
 const rows=[...ADDITIVE,...MAXIMA].map(k=>{
  const limit=(r.values as any)[k];
  const used=(usage as any)[k];
  return {key:k,label:LABELS[k],limit:limit===undefined?null:limit,used:used===undefined?null:used,unlimited:limit===undefined||limit===null,source:r.sources[k]?.source||'none',plans:r.sources[k]?.plans||[]};
 });
 return {enabled:r.enabled,mode:r.mode,usage,rows,flags:Object.fromEntries(LIMIT_FLAGS.map(f=>[f,(r.values as any)[f]!==false])),
  allowedTemplates:Array.isArray(r.values.allowedTemplates)?r.values.allowedTemplates:null,allowedLocations:Array.isArray(r.values.allowedLocations)?r.values.allowedLocations:null};
}

export function limitRoutes(app:FastifyInstance){
 app.get('/api/limits/me',async(req)=>{
  const cfg=(await settings()).limits;
  if(req.actor!.role!=='admin'&&!cfg.showUsage)return {enabled:cfg.enabled,mode:cfg.mode,hidden:true,rows:[],usage:null,flags:{}};
  return limitsView(req.actor!.id);
 });
 app.get('/api/customers/:id/limits',async(req)=>{
  admin(req);
  const id=asId((req.params as any).id);
  const u=(await pool.query("SELECT quota FROM users WHERE id=$1 AND role='customer'",[id])).rows[0];
  if(!u)fail(404,'Customer not found');
  return {...await limitsView(id),override:fromStorage(u.quota),defaults:fromStorage((await settings()).limits.defaults)};
 });
}

/** Periodically tells customers who are close to a limit. */
export async function sweepLimits(){
 const cfg=(await settings()).limits;
 if(!cfg.enabled||!cfg.notifyCustomer)return;
 const users=(await pool.query("SELECT DISTINCT owner_id FROM servers WHERE deleted_at IS NULL AND owner_id IN (SELECT id FROM users WHERE role='customer' AND NOT disabled) LIMIT 2000")).rows;
 for(const {owner_id} of users){
  const r=await resolveLimits(owner_id),usage=await usageOf(owner_id);
  for(const k of ADDITIVE){
   const limit=(r.values as any)[k];
   if(limit===undefined||limit===null||limit<=0)continue;
   const used=(usage as any)[k];
   if(used*100>=limit*cfg.warnPercent&&used<=limit)
    await notifyUser(owner_id,{kind:'limit.nearly',severity:'info',title:`You are using ${Math.round(used*100/limit)}% of your ${LABELS[k]}`,body:`${used} of ${limit} ${LABELS[k]} in use.`,dedupe:{key:`${owner_id}:${k}:near`,minutes:60*24*3}});
  }
 }
}
export const LIMIT_KEYS=[...LIMIT_NUMBERS];
