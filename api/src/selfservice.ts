import type {FastifyInstance} from 'fastify';
import {pool,fail,txt,asId,audit,enqueue,queueRecreate,serverAccess} from './core.js';
import {settings} from './settings.js';
import {provisionServer} from './provision.js';
import {resolveLimits,limitsView} from './limits.js';
import {effectiveDefs,checkValue} from './templates.js';
import {backupEnabled} from './storage.js';
import {bump} from './signup.js';
import {notifyUser} from './notifications.js';
import {createBackup} from './servers.js';

// Customers creating and deleting their own servers (Settings, Customers, "Self-service").
// Off by default. Servers made this way go through the same placement as the administrator's
// route and are checked against the customer's effective limits.

/** Admin-created accounts count as verified; people who signed up must have confirmed their address. */
export const isVerified=(u:{email_verified_at?:any;signup_source?:string})=>!!u.email_verified_at||u.signup_source==='admin'||!u.signup_source;
const CEIL={memoryMb:262144,cpuPercent:6400,diskMb:4194304};

async function whoCanCreate(userId:string){
 const cfg=(await settings()).selfService;
 const u=(await pool.query("SELECT id,email,status,disabled,email_verified_at,signup_source FROM users WHERE id=$1 AND role='customer'",[userId])).rows[0];
 if(!u||u.disabled||u.status!=='active')fail(403,'This account cannot create servers.');
 if(cfg.requireVerifiedEmail&&!isVerified(u))fail(403,'Confirm your email address before creating servers.');
 const r=await resolveLimits(userId);
 const flagOk=!r.enabled||r.mode==='warn'||(r.values as any).selfCreate!==false;
 return {cfg,flagOk,limits:r};
}

/** Locations a customer may use: the panel's list intersected with their plan's list. */
export function usableLocations(cfgLocations:string[],planLocations:unknown):string[]|null{
 const plan=Array.isArray(planLocations)?planLocations as string[]:null;
 if(cfgLocations.length&&plan)return cfgLocations.filter(l=>plan.includes(l));
 return cfgLocations.length?cfgLocations:plan;
}

export function selfServiceRoutes(app:FastifyInstance){
 // What the panel should offer this person. Drives the sidebar and the account menu; the server still checks every action.
 app.get('/api/features',async(req)=>{
  const all=await settings(),isCustomer=req.actor!.role==='customer';
  const subs=Number((await pool.query('SELECT count(*) n FROM subscriptions WHERE user_id=$1',[req.actor!.id])).rows[0].n);
  const u=(await pool.query('SELECT status FROM users WHERE id=$1',[req.actor!.id])).rows[0];
  return {
   store:{enabled:all.store.enabled||(isCustomer&&all.selfService.mode!=='off'),sells:all.store.enabled,title:all.store.title},
   // Administrators see Billing once it is in use (a provider chosen, a plan made or the store open); customers once they have something there.
   billing:{subscriptions:subs,visible:req.actor!.role==='admin'?(all.store.enabled||!!all.billing.provider||Number((await pool.query('SELECT count(*) n FROM plans')).rows[0].n)>0):(subs>0||all.store.enabled)},
   selfService:{mode:all.selfService.mode,canDelete:all.selfService.allowDelete,coolingHours:all.selfService.deleteCoolingHours},
   limits:{showUsage:all.limits.showUsage||!isCustomer,enabled:all.limits.enabled,mode:all.limits.mode},
   account:{status:u?.status||'active',allowDeletion:all.signup.allowAccountDeletion&&isCustomer,allowEmailChange:all.signup.allowEmailChange,allowExport:all.signup.allowDataExport,minPasswordLength:all.signup.minPasswordLength},
  };
 });
 // Which templates customers may use, and what they read about them. Administrators only.
 app.put('/api/templates/:id/store',async(req)=>{
  if(req.actor!.role!=='admin')fail(403,'Provider administrator required');
  const b=req.body as any,id=txt((req.params as any).id,64);
  if(typeof b?.customerVisible!=='boolean')fail(400,'customerVisible must be true or false');
  const desc=b?.customerDescription===undefined||b.customerDescription===null?'':String(b.customerDescription).slice(0,300);
  const r=await pool.query('UPDATE templates SET customer_visible=$2,customer_description=$3 WHERE id=$1 RETURNING id',[id,b.customerVisible,desc||null]);
  if(!r.rowCount)fail(404,'Template not found');
  await audit(req.actor!.id,'template.store','template',id,{customerVisible:b.customerVisible});
  return {ok:true};
 });
 app.get('/api/me/servers/options',async(req)=>{
  if(req.actor!.role!=='customer')fail(403,'Customers only');
  const {cfg,flagOk,limits}=await whoCanCreate(req.actor!.id).catch(e=>({cfg:null as any,flagOk:false,limits:null as any,error:e}) as any);
  const base={mode:cfg?.mode||'off',canCreate:!!cfg&&cfg.mode!=='off'&&flagOk,canDelete:!!cfg&&cfg.allowDelete,coolingHours:cfg?.deleteCoolingHours??0};
  if(!cfg||cfg.mode==='off')return {...base,templates:[],locations:[],limits:null};
  const locations=usableLocations(cfg.allowedLocations,limits?.values.allowedLocations);
  const known=(await pool.query("SELECT DISTINCT location FROM nodes WHERE deleted_at IS NULL AND status='connected' AND NOT draining ORDER BY location")).rows.map((r:any)=>r.location as string);
  const allowedT=limits?.values.allowedTemplates;
  const templates=(await pool.query("SELECT id,name,customer_description,memory_mb,cpu_percent,disk_mb,editable_variables,variables FROM templates WHERE customer_visible ORDER BY official DESC,name")).rows
   .filter((t:any)=>!Array.isArray(allowedT)||allowedT.includes(t.id))
   .map((t:any)=>({id:t.id,name:t.name,description:t.customer_description||'',memoryMb:t.memory_mb,cpuPercent:t.cpu_percent,diskMb:t.disk_mb,variables:effectiveDefs(t).filter(d=>d.userEditable&&!d.secret).map(d=>({key:d.key,label:d.label,description:d.description,type:d.type,options:d.options,min:d.min,max:d.max,required:d.required}))}));
  return {...base,templates,locations:(locations||known).filter(l=>known.includes(l)),customResources:cfg.mode==='custom',ceilings:CEIL,limits:await limitsView(req.actor!.id)};
 });

 app.post('/api/me/servers',async(req)=>{
  if(req.actor!.role!=='customer'||req.actor!.tokenScopes)fail(403,'Browser session required');
  const b=req.body as any;
  const {cfg,flagOk,limits}=await whoCanCreate(req.actor!.id);
  if(cfg.mode!=='custom')fail(403,'Creating servers yourself is turned off. Choose a plan in the store instead.');
  if(!flagOk)fail(403,'Your plan does not let you create servers yourself.');
  if(await bump(`create:${req.actor!.id}`,3600)>cfg.createsPerHour)fail(429,'You are creating servers too quickly. Try again a little later.');
  const templateId=txt(b?.templateId),name=txt(b?.name,80);
  const t=(await pool.query('SELECT * FROM templates WHERE id=$1 AND customer_visible',[templateId])).rows[0];
  if(!t)fail(404,'That kind of server is not available.');
  const bound=(v:any,def:number,max:number,label:string)=>{if(v===undefined||v===null||v==='')return def;const n=Number(v);if(!Number.isInteger(n)||n<1||n>max)fail(400,`${label} is out of range`);return n;};
  const memoryMb=bound(b?.memoryMb,t.memory_mb,CEIL.memoryMb,'Memory'),cpuPercent=bound(b?.cpuPercent,t.cpu_percent,CEIL.cpuPercent,'CPU'),diskMb=bound(b?.diskMb,t.disk_mb,CEIL.diskMb,'Disk');
  if(memoryMb<256)fail(400,'Memory must be at least 256 MB');
  const defs=effectiveDefs(t).filter(d=>d.userEditable);
  const variables:Record<string,string>={};
  if(b?.variables!==undefined){
   if(!b.variables||typeof b.variables!=='object'||Array.isArray(b.variables))fail(400,'Invalid settings');
   for(const [k,v] of Object.entries(b.variables as Record<string,unknown>)){
    const def=defs.find(d=>d.key===k);
    if(!def)fail(400,'Only the settings offered for this kind of server can be changed.');
    variables[k]=checkValue(def!,v);
   }
  }
  const locs=usableLocations(cfg.allowedLocations,limits.values.allowedLocations);
  const location=b?.location?txt(b.location,80):null;
  if(location&&locs&&!locs.includes(location))fail(400,'That location is not available to you.');
  const r=await provisionServer({ownerId:req.actor!.id,templateId,name,location,locations:locs,memoryMb,cpuPercent,diskMb,variables,actorId:req.actor!.id,actorIsAdmin:false,createdVia:'self',friendlyErrors:true});
  return r.shape;
 });

 // ---- Deleting your own server (with a cooling-off period) ----
 const mine=async(req:any)=>{
  const s=await serverAccess(req,(req.params as any).id);
  if(s.owner_id!==req.actor.id||req.actor.role!=='customer')fail(404,'Server not found');
  return s;
 };
 app.delete('/api/me/servers/:id',async(req)=>{
  const s=await mine(req),cfg=(await settings()).selfService;
  if(req.actor!.tokenScopes)fail(403,'Browser session required');
  if(!cfg.allowDelete)fail(403,'Deleting servers yourself is turned off. Contact support.');
  const lim=(await resolveLimits(req.actor!.id)).values as any;
  if(lim.selfDelete===false)fail(403,'Your plan does not let you delete servers yourself.');
  if(s.subscription_id)fail(409,'This server belongs to a subscription. Cancel the subscription instead; the server is removed when it ends.');
  if((req.body as any)?.confirm!==true)fail(400,'Deleting a server removes its data. Send {confirm:true}.');
  if(s.observed_status==='deleting')fail(409,'Deletion is already pending');
  if(s.pending_delete_at)fail(409,'This server is already scheduled for deletion');
  // A last backup first, when backups exist and none is fresh.
  if(cfg.backupBeforeDelete&&await backupEnabled()&&s.node_status==='connected'){
   const fresh=(await pool.query("SELECT 1 FROM backups WHERE server_id=$1 AND state IN ('queued','running','succeeded') AND created_at>now()-interval '1 hour'",[s.id])).rowCount;
   // A failing backup (for example the customer's backup limit) never blocks the deletion they asked for.
   if(!fresh)await createBackup(req,s).catch(e=>console.error('Backup before delete skipped:',(e as Error)?.message));
  }
  if(cfg.deleteCoolingHours===0){
   if(s.node_status!=='connected')fail(503,'The server’s node is offline right now. Try again later.');
   await pool.query("UPDATE servers SET observed_status='deleting' WHERE id=$1",[s.id]);
   const j=await enqueue(s.node_id,s.id,'delete');
   await audit(req.actor!.id,'server.delete.request','server',s.id,{jobId:j.id,via:'owner'});
   return {ok:true,deleted:true};
  }
  const row=(await pool.query("UPDATE servers SET pending_delete_at=now()+make_interval(hours=>$2),desired_status='stopped',suspended=true,suspended_reason='owner-deleted' WHERE id=$1 RETURNING pending_delete_at",[s.id,cfg.deleteCoolingHours])).rows[0];
  if(s.node_status==='connected')await enqueue(s.node_id,s.id,'stop');
  await audit(req.actor!.id,'server.delete.schedule','server',s.id,{at:row.pending_delete_at});
  return {ok:true,deleted:false,deletesAt:row.pending_delete_at};
 });
 app.post('/api/me/servers/:id/restore',async(req)=>{
  const s=await mine(req);
  if(!s.pending_delete_at)fail(409,'This server is not scheduled for deletion');
  await pool.query("UPDATE servers SET pending_delete_at=NULL,suspended=false,suspended_reason=NULL,desired_status='running' WHERE id=$1",[s.id]);
  if(s.node_status==='connected')await enqueue(s.node_id,s.id,'start');
  await audit(req.actor!.id,'server.delete.cancel','server',s.id);
  return {ok:true};
 });
}

/** Carries out deletions whose cooling-off period is over. */
export async function sweepOwnerDeletes(){
 const due=(await pool.query("SELECT s.id,s.node_id,s.owner_id,s.name,n.status AS node_status FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.pending_delete_at<=now() AND s.deleted_at IS NULL AND s.observed_status<>'deleting' LIMIT 20")).rows;
 for(const s of due){
  if(s.node_status!=='connected')continue;
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const ok=await c.query("UPDATE servers SET observed_status='deleting',pending_delete_at=NULL WHERE id=$1 AND observed_status<>'deleting' RETURNING id",[s.id]);
   if(ok.rowCount)await c.query("INSERT INTO jobs(node_id,server_id,kind) VALUES($1,$2,'delete')",[s.node_id,s.id]);
   await c.query('COMMIT');
   if(ok.rowCount){await audit(null,'server.delete.execute','server',s.id,{via:'owner'});await notifyUser(s.owner_id,{kind:'server.deleted',title:`${s.name} was deleted`,severity:'info'});}
  }catch(e){await c.query('ROLLBACK').catch(()=>{});}finally{c.release();}
 }
}
void queueRecreate;
