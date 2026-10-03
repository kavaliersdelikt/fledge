import {requireFlag} from './limits.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {pool,fail,asId,serverAccess,audit,enqueue} from './core.js';
import {backupEnabled} from './storage.js';
import {createBackup,active,syncOperation} from './servers.js';
import {cachedCall,callPlugin,atLeast,emitHook,type PluginRow} from './plugins/manager.js';
import {networkHosts} from './plugins/manifest.js';

// Add-ons: mods and plugins that a catalog plugin (for example the Modrinth browsers) installs
// into a server's mods/ or plugins/ folder. The plugin only describes what exists and which
// files a version consists of; this module checks every answer, decides what gets written and
// has the node download, verify and place the files.

export const MIN_AGENT='0.6.1.1';
const FILE_NAME=/^[A-Za-z0-9._+()\[\] -]{1,128}\.jar$/;
const MAX_FILE_BYTES=256<<20;
const MAX_PLAN_ITEMS=15;

export type Capability={supported:boolean;reason?:string;kind?:string;dir?:string;loaders?:string[];gameVersion?:string|null;type?:string};
type Rule={kind:string;dir:string;loaders:string[]};

/** What a server can take, from its template's add-on rules and the server's own variables. */
export function capabilityFor(s:{template_addons:any;env:Record<string,string>;variables:Record<string,string>}):Capability{
 const a=s.template_addons;
 if(!a||typeof a!=='object'||!a.types)return {supported:false,reason:'This template does not support mods or plugins.'};
 const val=(k:string)=>String((s.variables||{})[k]??(s.env||{})[k]??'').trim();
 const type=val(a.typeVar||'TYPE').toUpperCase();
 const rule:Rule|undefined=a.types[type];
 if(!rule)return {supported:false,type,reason:type?`${type[0]+type.slice(1).toLowerCase()} servers do not load mods or plugins. Switch the server type (for example to Paper or Fabric) in its settings.`:'Set a server type (for example Paper or Fabric) in the server settings to use add-ons.'};
 const v=val(a.versionVar||'VERSION');
 const gameVersion=/^\d+(\.\d+){1,3}$/.test(v)?v:null;
 return {supported:true,kind:rule.kind,dir:rule.dir,loaders:rule.loaders,gameVersion,type};
}
const targetOf=(c:Capability)=>({kind:c.kind,loaders:c.loaders,gameVersion:c.gameVersion,type:c.type});

// --- Cleaning what plugins return --------------------------------------------------------
const s=(v:unknown,max:number)=>typeof v==='string'?v.slice(0,max):'';
const n=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:0;
const okHost=(url:unknown,hosts:string[])=>{
 if(typeof url!=='string'||url.length>600)return false;
 try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&hosts.some(h=>h.startsWith('*.')?u.hostname.endsWith(h.slice(1)):u.hostname===h);}catch{return false;}
};
const img=(url:unknown,hosts:string[])=>okHost(url,hosts)?String(url):null;
const link=(url:unknown)=>{try{const u=new URL(String(url));return u.protocol==='https:'&&!u.username?u.toString().slice(0,400):null;}catch{return null;}};
const side=(v:unknown)=>['required','optional','unsupported','unknown'].includes(v as string)?v as string:'unknown';

export function cleanSearch(r:any,hosts:string[]){
 return {total:n(r?.total),offset:n(r?.offset),limit:n(r?.limit),items:(Array.isArray(r?.items)?r.items:[]).slice(0,60).map((i:any)=>({id:s(i?.id,100),slug:s(i?.slug,100),title:s(i?.title,120),summary:s(i?.summary,400),iconUrl:img(i?.iconUrl,hosts),author:s(i?.author,80),downloads:n(i?.downloads),follows:n(i?.follows),categories:(Array.isArray(i?.categories)?i.categories:[]).slice(0,8).map((c:unknown)=>s(c,40)),clientSide:side(i?.clientSide),serverSide:side(i?.serverSide),updatedAt:s(i?.updatedAt,40),url:link(i?.url)})).filter((i:any)=>i.id&&i.title)};
}
export function cleanProject(p:any,hosts:string[]){
 return {id:s(p?.id,100),slug:s(p?.slug,100),title:s(p?.title,120),summary:s(p?.summary,400),description:s(p?.description,60000),iconUrl:img(p?.iconUrl,hosts),categories:(Array.isArray(p?.categories)?p.categories:[]).slice(0,14).map((c:unknown)=>s(c,40)),license:p?.license?s(p.license,100):null,clientSide:side(p?.clientSide),serverSide:side(p?.serverSide),downloads:n(p?.downloads),follows:n(p?.follows),updatedAt:s(p?.updatedAt,40),publishedAt:s(p?.publishedAt,40),
  gallery:(Array.isArray(p?.gallery)?p.gallery:[]).slice(0,8).map((g:any)=>({url:img(g?.url,hosts),title:s(g?.title,100)})).filter((g:any)=>g.url),
  links:Object.fromEntries(Object.entries(p?.links||{}).map(([k,v])=>[k.slice(0,20),link(v)]).filter(([,v])=>v))};
}
function cleanFile(f:any,hosts:string[]){
 const file={url:s(f?.url,600),filename:s(f?.filename,200),sha512:s(f?.sha512,200).toLowerCase(),size:n(f?.size)};
 if(!okHost(file.url,hosts))fail(502,`The plugin offered a download from a host it is not allowed to use (${file.url.slice(0,80)})`);
 if(!FILE_NAME.test(file.filename)||file.filename.startsWith('.'))fail(502,`The plugin offered a file with an unsafe name (${file.filename.slice(0,60)})`);
 if(!/^[a-f0-9]{128}$/.test(file.sha512))fail(502,'The plugin offered a file without a SHA-512 checksum, so it cannot be verified');
 if(!file.size||file.size>MAX_FILE_BYTES)fail(502,'The plugin offered a file with an invalid size');
 return file;
}
function cleanVersion(v:any){return {id:s(v?.id,100),label:s(v?.label,100),name:s(v?.name,200),channel:['release','beta','alpha'].includes(v?.channel)?v.channel:'release',publishedAt:s(v?.publishedAt,40),gameVersions:(Array.isArray(v?.gameVersions)?v.gameVersions:[]).slice(0,60).map((x:unknown)=>s(x,30)),loaders:(Array.isArray(v?.loaders)?v.loaders:[]).slice(0,20).map((x:unknown)=>s(x,30)),downloads:n(v?.downloads),changelog:s(v?.changelog,6000),
 files:(Array.isArray(v?.files)?v.files:[]).slice(0,6).map((f:any)=>({filename:s(f?.filename,200),size:n(f?.size),primary:!!f?.primary}))};}

// --- Providers -----------------------------------------------------------------------
type Provider={plugin:PluginRow;catalogId:string;hosts:string[]};
async function providers(cap:Capability):Promise<Provider[]>{
 if(!cap.supported)return [];
 const rows=(await pool.query("SELECT * FROM plugins WHERE enabled AND manifest->'catalogs' @> $1::jsonb ORDER BY name",[JSON.stringify([{kind:cap.kind}])])).rows as PluginRow[];
 return rows.filter(p=>p.granted_permissions.includes('servers:read')).map(p=>({plugin:p,catalogId:p.manifest.catalogs.find(c=>c.kind===cap.kind)!.id,hosts:networkHosts(p.manifest.permissions).filter(h=>p.granted_permissions.includes('network:'+h))}));
}
async function provider(cap:Capability,pluginId:unknown):Promise<Provider>{
 const list=await providers(cap);
 const p=list.find(x=>x.plugin.id===pluginId)||(pluginId===undefined?list[0]:undefined);
 if(!p)fail(404,list.length?'That catalog is not available for this server':'No catalog plugin is turned on for this kind of server. An administrator can install one under Plugins.');
 return p!;
}
const canWrite=(p:Provider)=>p.plugin.granted_permissions.includes('servers:files.write');

const shapeAddon=(a:any)=>({id:a.id,pluginId:a.plugin_id,kind:a.kind,projectId:a.project_id,title:a.project_title,slug:a.project_slug,iconUrl:a.icon_url,versionId:a.version_id,versionLabel:a.version_label,filename:a.filename,sizeBytes:a.size_bytes===null?null:Number(a.size_bytes),state:a.state,disabled:a.disabled,pinned:a.pinned,isDependency:a.is_dependency,error:a.error,installedAt:a.installed_at,updatedAt:a.updated_at});
const diskName=(a:{filename:string;disabled:boolean})=>a.filename+(a.disabled?'.disabled':'');
async function tracked(serverId:string){return (await pool.query("SELECT * FROM server_addons WHERE server_id=$1 ORDER BY lower(project_title)",[serverId])).rows;}

function readiness(server:any){
 const agentOk=!!server.node_version&&atLeast(String(server.node_version),MIN_AGENT);
 return {agentOk,agentVersion:server.node_version||null,requiredAgent:MIN_AGENT};
}
function mustBeWritable(server:any){
 active(server);
 if(server.suspended)fail(409,'This server is suspended');
 if(server.node_status!=='connected')fail(503,'The server’s node is offline');
 const r=readiness(server);
 if(!r.agentOk)fail(409,`The node’s agent (${r.agentVersion||'unknown'}) is too old for add-ons. Update it to ${MIN_AGENT} or newer on the Nodes page.`);
}

// --- Planning an install ---------------------------------------------------------------
type PlanItem={role:'main'|'required'|'optional';projectId:string;title:string;slug:string|null;iconUrl:string|null;versionId:string;versionLabel:string;channel:string;file:{url:string;filename:string;sha512:string;size:number}|null;alreadyInstalled:boolean;note?:string;selected:boolean};
type Plan={items:PlanItem[];blockers:string[];warnings:string[]};

async function resolveOne(p:Provider,cap:Capability,projectId:string|null,versionId:string|null){
 const r:any=await callPlugin(p.plugin.id,'resolve',[{projectId,versionId},targetOf(cap)]);
 const project=r?.project||{},version=r?.version||{};
 const file=Array.isArray(r?.files)?r.files[0]:null;
 if(!file)fail(502,'The plugin did not return a file to install');
 return {projectId:s(project.id,100),title:s(project.title,120)||'Unknown',slug:s(project.slug,100)||null,iconUrl:img(project.iconUrl,p.hosts),versionId:s(version.id,100),versionLabel:s(version.label,100),channel:['release','beta','alpha'].includes(version.channel)?version.channel:'release',file:cleanFile(file,p.hosts),
  dependencies:(Array.isArray(r?.dependencies)?r.dependencies:[]).slice(0,40).map((d:any)=>({projectId:d?.projectId?s(d.projectId,100):null,versionId:d?.versionId?s(d.versionId,100):null,type:s(d?.type,20)}))};
}

async function buildPlan(server:any,cap:Capability,p:Provider,input:{projectId:string;versionId?:string|null;optional?:string[];updating?:any}):Promise<Plan>{
 const plan:Plan={items:[],blockers:[],warnings:[]};
 const have=await tracked(server.id);
 const byProject=new Map(have.filter(a=>a.plugin_id===p.plugin.id&&a.state!=='failed').map(a=>[a.project_id,a]));
 const seen=new Set<string>();
 const names=new Set(have.filter(a=>a.state!=='failed').map(a=>diskName(a).replace(/\.disabled$/,'')));
 const queue:{projectId:string|null;versionId:string|null;role:'main'|'required'|'optional';depth:number}[]=[{projectId:input.projectId,versionId:input.versionId||null,role:'main',depth:0}];
 for(const o of input.optional||[])queue.push({projectId:o,versionId:null,role:'optional',depth:1});
 const incompatible:string[]=[];
 while(queue.length){
  const q=queue.shift()!;
  if(plan.items.length>=MAX_PLAN_ITEMS){plan.blockers.push('This add-on has too many dependencies to install automatically.');break;}
  if(q.projectId&&seen.has(q.projectId))continue;
  const existing=q.projectId?byProject.get(q.projectId):undefined;
  if(existing&&q.role!=='main'){plan.items.push({role:q.role,projectId:existing.project_id,title:existing.project_title,slug:existing.project_slug,iconUrl:existing.icon_url,versionId:existing.version_id,versionLabel:existing.version_label,channel:'release',file:null,alreadyInstalled:true,selected:false});seen.add(existing.project_id);continue;}
  if(existing&&q.role==='main'&&!input.updating){plan.blockers.push(`${existing.project_title} is already installed${existing.disabled?' (disabled)':''}. Use Updates or the add-on list instead.`);return plan;}
  let r;
  try{r=await resolveOne(p,cap,q.projectId,q.versionId);}
  catch(e:any){
   if(q.role==='main')throw e;
   (q.role==='required'?plan.blockers:plan.warnings).push(`${q.role==='required'?'A required dependency':'An optional dependency'} could not be resolved: ${String(e?.message||'').slice(0,160)}`);continue;
  }
  seen.add(r.projectId);
  if(q.role==='main'&&q.projectId&&r.projectId!==q.projectId)plan.warnings.push('The plugin returned a different project than requested.');
  const clash=have.find(a=>a.state!=='failed'&&a.filename===r.file.filename&&a.project_id!==r.projectId);
  if(clash)plan.blockers.push(`A file named ${r.file.filename} already belongs to ${clash.project_title}.`);
  if(names.has(r.file.filename)&&!existing&&!clash)plan.warnings.push(`${r.file.filename} is already in the folder; it will be replaced.`);
  plan.items.push({role:q.role,projectId:r.projectId,title:r.title,slug:r.slug,iconUrl:r.iconUrl,versionId:r.versionId,versionLabel:r.versionLabel,channel:r.channel,file:r.file,alreadyInstalled:false,selected:true});
  if(r.channel!=='release')plan.warnings.push(`${r.title} ${r.versionLabel} is a ${r.channel} build.`);
  for(const d of r.dependencies){
   if(d.type==='incompatible'&&d.projectId&&byProject.has(d.projectId))incompatible.push(`${r.title} is incompatible with ${byProject.get(d.projectId).project_title}, which is installed.`);
   else if(d.type==='required'&&(d.projectId||d.versionId)&&q.depth<3)queue.push({projectId:d.projectId,versionId:d.versionId,role:'required',depth:q.depth+1});
   else if(d.type==='optional'&&d.projectId&&q.depth===0&&!seen.has(d.projectId)&&!byProject.has(d.projectId)&&!(input.optional||[]).includes(d.projectId)&&plan.items.filter(i=>i.role==='optional'&&!i.file).length<5)plan.items.push({role:'optional',projectId:d.projectId,title:'',slug:null,iconUrl:null,versionId:'',versionLabel:'',channel:'release',file:null,alreadyInstalled:false,selected:false});
  }
 }
 plan.blockers.push(...incompatible);
 // Titles for suggested (unresolved) optional dependencies.
 for(const it of plan.items.filter(i=>i.role==='optional'&&!i.file&&!i.title)){
  try{const pr=cleanProject(await cachedCall(p.plugin.id,'project',[it.projectId,targetOf(cap)],10*60_000),p.hosts);it.title=pr.title||it.projectId;it.iconUrl=pr.iconUrl;it.slug=pr.slug||null;}catch{it.title=it.projectId;}
 }
 return plan;
}

// --- Queueing the file jobs --------------------------------------------------------------
async function queueInstall(req:FastifyRequest,server:any,cap:Capability,p:Provider,plan:Plan,opts:{backupFirst:boolean}){
 const items=plan.items.filter(i=>i.file&&i.selected&&!i.alreadyInstalled);
 if(!items.length)fail(409,'There is nothing to install');
 if(opts.backupFirst){if(!(await backupEnabled()))fail(503,'Backups need object storage, so a backup cannot be taken first');await createBackup(req,server);}
 const out:any[]=[];
 for(const it of items){
  const f=it.file!;
  const row=(await pool.query(`INSERT INTO server_addons(server_id,plugin_id,provider,kind,dir,project_id,project_title,project_slug,icon_url,version_id,version_label,filename,sha512,size_bytes,source_url,is_dependency,installed_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(server_id,plugin_id,project_id) WHERE state<>'failed' DO NOTHING RETURNING *`,
   [server.id,p.plugin.id,p.plugin.id,cap.kind,cap.dir,it.projectId,it.title,it.slug,it.iconUrl,it.versionId,it.versionLabel,f.filename,f.sha512,f.size,f.url,it.role!=='main',req.actor!.id])).rows[0];
  if(!row)continue;
  await pool.query("DELETE FROM server_addons WHERE server_id=$1 AND plugin_id=$2 AND project_id=$3 AND state='failed' AND id<>$4",[server.id,p.plugin.id,it.projectId,row.id]);
  const job=await enqueue(server.node_id,server.id,'file.fetch',{addonId:row.id,path:`${cap.dir}/${f.filename}`,url:f.url,sha512:f.sha512,size:f.size,allowedHosts:p.hosts,maxBytes:MAX_FILE_BYTES});
  await pool.query('UPDATE server_addons SET job_id=$1 WHERE id=$2',[job.id,row.id]);
  out.push({...shapeAddon({...row,job_id:job.id}),jobId:job.id});
 }
 await audit(req.actor!.id,'addon.install','server',server.id,{plugin:p.plugin.id,items:items.map(i=>({project:i.projectId,title:i.title,version:i.versionLabel}))});
 return out;
}

// What the agent reported for an add-on job. Called from the agent result route, inside its transaction.
export async function applyAddonResult(c:{query:(q:string,a?:any[])=>Promise<any>},job:any,success:boolean,result:any,error:string|null){
 const addonId=job.payload?.addonId;if(!addonId||!/^[a-f0-9-]{36}$/i.test(addonId))return null;
 if(job.kind==='file.fetch'){
  if(success){
   const u=job.payload.update;
   if(u)await c.query("UPDATE server_addons SET state='installed',error=NULL,version_id=$2,version_label=$3,filename=$4,sha512=$5,size_bytes=$6,source_url=$7,project_title=COALESCE(NULLIF($8,''),project_title),icon_url=COALESCE($9,icon_url),updated_at=now() WHERE id=$1",[addonId,u.versionId,u.versionLabel,u.filename,u.sha512,u.size,u.url,u.title||'',u.iconUrl||null]);
   else{await c.query("UPDATE server_addons SET state='installed',error=NULL,size_bytes=COALESCE($2,size_bytes),installed_at=now(),updated_at=now() WHERE id=$1",[addonId,Number.isFinite(result?.sizeBytes)?result.sizeBytes:null]);emitHook('addon.installed',{serverId:job.server_id,addonId});}
  }else if(job.payload.update)await c.query("UPDATE server_addons SET state='installed',error=$2,updated_at=now() WHERE id=$1",[addonId,`Update failed: ${(error||'').slice(0,300)}`]);
  else await c.query("UPDATE server_addons SET state='failed',error=$2,updated_at=now() WHERE id=$1",[addonId,(error||'Install failed').slice(0,500)]);
 }else if(job.kind==='file.delete'){
  if(success){await c.query('DELETE FROM server_addons WHERE id=$1',[addonId]);emitHook('addon.removed',{serverId:job.server_id,addonId});}
  else await c.query("UPDATE server_addons SET state='installed',error=$2,updated_at=now() WHERE id=$1",[addonId,`Could not remove: ${(error||'').slice(0,300)}`]);
 }else if(job.kind==='file.rename'){
  if(success)await c.query('UPDATE server_addons SET disabled=$2,error=NULL,updated_at=now() WHERE id=$1',[addonId,job.payload.disabled===true]);
  else await c.query('UPDATE server_addons SET error=$2,updated_at=now() WHERE id=$1',[addonId,`Could not change: ${(error||'').slice(0,300)}`]);
 }
 return {kind:job.kind,success,addonId};
}

// An add-on with a queued or running job must not be renamed, removed or updated again: the agent would act on a path that is about to change.
async function busy(addonId:string){return !!(await pool.query("SELECT 1 FROM jobs WHERE state IN ('queued','running') AND kind IN ('file.fetch','file.delete','file.rename') AND payload->>'addonId'=$1 LIMIT 1",[addonId])).rowCount;}
// Rows whose job never reported back (node gone for good, job cancelled) are not left in a pending state forever.
export async function sweepAddons(){
 await pool.query("UPDATE server_addons SET state='failed',error='The node did not install this add-on in time',updated_at=now() WHERE state='pending' AND updated_at<now()-interval '30 minutes' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=server_addons.job_id AND j.state IN ('queued','running'))");
 await pool.query("UPDATE server_addons SET state='installed',error='Removal did not finish; try again',updated_at=now() WHERE state='removing' AND updated_at<now()-interval '30 minutes' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=server_addons.job_id AND j.state IN ('queued','running'))");
}

// --- Routes --------------------------------------------------------------------------------
const clean=(v:unknown,max=100)=>{if(typeof v!=='string'||!v||v.length>max||/[\u0000-\u001f]/.test(v))fail(400,'Invalid request');return v as string;};
async function context(req:FastifyRequest){
 const server=await serverAccess(req,(req.params as any).id,'files');
 return {server,cap:capabilityFor(server)};
}
export function addonRoutes(app:FastifyInstance){
 app.get('/api/servers/:id/addons',async(req)=>{
  const {server,cap}=await context(req);
  const provs=await providers(cap);
  return {capability:cap,...readiness(server),writable:server.node_status==='connected'&&!server.suspended,
   providers:provs.map(p=>({pluginId:p.plugin.id,name:p.plugin.name,icon:p.plugin.icon,catalogId:p.catalogId,canInstall:canWrite(p)})),
   installed:(await tracked(server.id)).map(shapeAddon)};
 });
 app.get('/api/servers/:id/addons/search',async(req)=>{
  const {server,cap}=await context(req),q=req.query as any;
  const p=await provider(cap,q.pluginId);
  const params={query:typeof q.q==='string'?q.q.slice(0,100):'',offset:Math.max(0,Number(q.offset)||0),limit:Math.min(50,Math.max(1,Number(q.limit)||24)),sort:['relevance','downloads','follows','newest','updated'].includes(q.sort)?q.sort:'relevance',categories:typeof q.categories==='string'?q.categories.split(',').filter(Boolean).slice(0,5):[],...(q.showClientOnly==='1'?{showClientOnly:true}:q.showClientOnly==='0'?{showClientOnly:false}:{})};
  const r=cleanSearch(await cachedCall(p.plugin.id,'search',[params,targetOf(cap)],90_000),p.hosts);
  const have=new Map((await tracked(server.id)).filter(a=>a.plugin_id===p.plugin.id).map(a=>[a.project_id,a]));
  return {...r,items:r.items.map((i:any)=>({...i,installedAddonId:have.get(i.id)?.id||null,installedVersion:have.get(i.id)?.version_label||null}))};
 });
 app.get('/api/servers/:id/addons/categories',async(req)=>{
  const {cap}=await context(req),p=await provider(cap,(req.query as any).pluginId);
  const r:any=await cachedCall(p.plugin.id,'categories',[targetOf(cap)],60*60_000).catch(()=>[]);
  return (Array.isArray(r)?r:[]).slice(0,80).map((c:any)=>({id:s(c?.id,40),label:s(c?.label,60)})).filter((c:any)=>/^[a-z0-9-]{2,40}$/.test(c.id));
 });
 app.get('/api/servers/:id/addons/project',async(req)=>{
  const {cap}=await context(req),q=req.query as any,p=await provider(cap,q.pluginId);
  return cleanProject(await cachedCall(p.plugin.id,'project',[clean(q.projectId),targetOf(cap)],10*60_000),p.hosts);
 });
 app.get('/api/servers/:id/addons/versions',async(req)=>{
  const {cap}=await context(req),q=req.query as any,p=await provider(cap,q.pluginId);
  const r:any=await cachedCall(p.plugin.id,'versions',[clean(q.projectId),targetOf(cap)],3*60_000);
  return (Array.isArray(r)?r:[]).slice(0,40).map(cleanVersion);
 });
 app.post('/api/servers/:id/addons/plan',async(req)=>{
  const {server,cap}=await context(req),b=req.body as any,p=await provider(cap,b?.pluginId);
  mustBeWritable(server);if(!canWrite(p))fail(403,'This plugin is not allowed to add files to servers');
  return buildPlan(server,cap,p,{projectId:clean(b?.projectId),versionId:b?.versionId?clean(b.versionId):null,optional:Array.isArray(b?.optional)?b.optional.slice(0,5).map((x:unknown)=>clean(x)):[]});
 });
 app.post('/api/servers/:id/addons/install',async(req)=>{
  const {server,cap}=await context(req),b=req.body as any,p=await provider(cap,b?.pluginId);
  mustBeWritable(server);if(!canWrite(p))fail(403,'This plugin is not allowed to add files to servers');
  await requireFlag(server.owner_id,'addons','Installing mods and plugins is not part of your plan.',{actorIsAdmin:req.actor?.role==='admin'});
  const plan=await buildPlan(server,cap,p,{projectId:clean(b?.projectId),versionId:b?.versionId?clean(b.versionId):null,optional:Array.isArray(b?.optional)?b.optional.slice(0,5).map((x:unknown)=>clean(x)):[]});
  if(plan.blockers.length)fail(409,plan.blockers.join(' '));
  const addons=await queueInstall(req,server,cap,p,plan,{backupFirst:b?.backupFirst===true});
  return {addons,warnings:plan.warnings,restartRequired:true};
 });
 app.patch('/api/servers/:id/addons/:addonId',async(req)=>{
  const {server,cap}=await context(req),b=req.body as any;
  const a=(await pool.query('SELECT * FROM server_addons WHERE id=$1 AND server_id=$2',[asId((req.params as any).addonId),server.id])).rows[0];
  if(!a)fail(404,'Add-on not found');
  if(typeof b?.pinned==='boolean')await pool.query('UPDATE server_addons SET pinned=$2,updated_at=now() WHERE id=$1',[a.id,b.pinned]);
  if(typeof b?.disabled==='boolean'&&b.disabled!==a.disabled){
   mustBeWritable(server);
   if(a.state!=='installed'||await busy(a.id))fail(409,'Wait for the current operation on this add-on to finish');
   const from=`${a.dir}/${diskName(a)}`,to=`${a.dir}/${a.filename}${b.disabled?'.disabled':''}`;
   const job=await enqueue(server.node_id,server.id,'file.rename',{addonId:a.id,from,to,disabled:b.disabled});
   await pool.query('UPDATE server_addons SET job_id=$2,error=NULL WHERE id=$1',[a.id,job.id]);
   await audit(req.actor!.id,b.disabled?'addon.disable':'addon.enable','server',server.id,{addon:a.project_title});
  }
  void cap;
  return shapeAddon((await pool.query('SELECT * FROM server_addons WHERE id=$1',[a.id])).rows[0]);
 });
 app.delete('/api/servers/:id/addons/:addonId',async(req)=>{
  const {server}=await context(req);
  const a=(await pool.query('SELECT * FROM server_addons WHERE id=$1 AND server_id=$2',[asId((req.params as any).addonId),server.id])).rows[0];
  if(!a)fail(404,'Add-on not found');
  if(a.state==='failed'){await pool.query('DELETE FROM server_addons WHERE id=$1',[a.id]);return {ok:true,removed:true};}
  if(a.state!=='installed'||await busy(a.id))fail(409,'Wait for the current operation on this add-on to finish');
  mustBeWritable(server);
  const claimed=await pool.query("UPDATE server_addons SET state='removing',updated_at=now() WHERE id=$1 AND state='installed' RETURNING id",[a.id]);
  if(!claimed.rowCount)fail(409,'This add-on is already being changed');
  const job=await enqueue(server.node_id,server.id,'file.delete',{addonId:a.id,paths:[`${a.dir}/${diskName(a)}`]});
  await pool.query('UPDATE server_addons SET job_id=$2 WHERE id=$1',[a.id,job.id]);
  await audit(req.actor!.id,'addon.remove','server',server.id,{addon:a.project_title});
  return {ok:true,jobId:job.id,restartRequired:true};
 });
 app.get('/api/servers/:id/addons/updates',async(req)=>{
  const {server,cap}=await context(req);
  const refresh=(req.query as any)?.refresh==='1';
  const have=(await tracked(server.id)).filter(a=>a.state==='installed'&&a.sha512);
  const result:any[]=[];
  for(const p of await providers(cap)){
   const mine=have.filter(a=>a.plugin_id===p.plugin.id&&a.kind===cap.kind);
   if(!mine.length)continue;
   const args=[{items:mine.map(a=>({projectId:a.project_id,versionId:a.version_id,sha512:a.sha512}))},targetOf(cap)];
   const r:any=refresh?await callPlugin(p.plugin.id,'updates',args):await cachedCall(p.plugin.id,'updates',args,5*60_000);
   for(const u of Array.isArray(r)?r:[]){
    const a=mine.find(x=>x.project_id===u?.projectId);if(!a||!u?.latest?.id||u.latest.id===a.version_id)continue;
    result.push({addonId:a.id,pluginId:p.plugin.id,projectId:a.project_id,title:a.project_title,iconUrl:a.icon_url,pinned:a.pinned,disabled:a.disabled,current:{versionId:a.version_id,label:a.version_label},latest:cleanVersion(u.latest)});
   }
  }
  return {updates:result,checkedAt:new Date().toISOString()};
 });
 app.post('/api/servers/:id/addons/update',async(req)=>{
  const {server,cap}=await context(req),b=req.body as any;
  mustBeWritable(server);
  const wanted=Array.isArray(b?.addonIds)?new Set<string>(b.addonIds.slice(0,60).map((x:unknown)=>asId(x))):null;
  const have=(await tracked(server.id)).filter(a=>a.state==='installed'&&a.sha512&&(!wanted||wanted.has(a.id))&&(wanted||!a.pinned));
  const queued:any[]=[],skipped:string[]=[];
  if(b?.backupFirst===true&&have.length){if(!(await backupEnabled()))fail(503,'Backups need object storage, so a backup cannot be taken first');await createBackup(req,server);}
  for(const p of await providers(cap)){
   if(!canWrite(p))continue;
   const mine=have.filter(a=>a.plugin_id===p.plugin.id&&a.kind===cap.kind);
   if(!mine.length)continue;
   const r:any=await callPlugin(p.plugin.id,'updates',[{items:mine.map(a=>({projectId:a.project_id,versionId:a.version_id,sha512:a.sha512}))},targetOf(cap)]);
   for(const u of Array.isArray(r)?r:[]){
    const a=mine.find(x=>x.project_id===u?.projectId);if(!a||!u?.latest?.id||u.latest.id===a.version_id)continue;
    if(await busy(a.id)){skipped.push(`${a.project_title}: another change is still in progress`);continue;}
    try{
     const plan=await buildPlan(server,cap,p,{projectId:a.project_id,versionId:u.latest.id,updating:a});
     if(plan.blockers.length){skipped.push(`${a.project_title}: ${plan.blockers.join(' ')}`);continue;}
     const main=plan.items.find(i=>i.role==='main'&&i.file);if(!main)continue;
     const f=main.file!,oldPath=`${a.dir}/${diskName(a)}`,suffix=a.disabled?'.disabled':'';
     const update={versionId:main.versionId,versionLabel:main.versionLabel,filename:f.filename,sha512:f.sha512,size:f.size,url:f.url,title:main.title,iconUrl:main.iconUrl};
     const newPath=`${a.dir}/${f.filename}${suffix}`;
     const job=await enqueue(server.node_id,server.id,'file.fetch',{addonId:a.id,path:newPath,url:f.url,sha512:f.sha512,size:f.size,allowedHosts:p.hosts,maxBytes:MAX_FILE_BYTES,update,replace:oldPath===newPath?[]:[oldPath]});
     await pool.query("UPDATE server_addons SET job_id=$2,error=NULL,updated_at=now() WHERE id=$1",[a.id,job.id]);
     queued.push({addonId:a.id,title:a.project_title,from:a.version_label,to:main.versionLabel,jobId:job.id});
     // New required dependencies of the new version are installed alongside.
     const extra={...plan,items:plan.items.filter(i=>i.role==='required'&&i.file&&!i.alreadyInstalled)};
     if(extra.items.length)await queueInstall(req,server,cap,p,extra,{backupFirst:false});
    }catch(e:any){skipped.push(`${a.project_title}: ${String(e?.message||'failed').slice(0,160)}`);}
   }
  }
  await audit(req.actor!.id,'addon.update','server',server.id,{updated:queued.map(q=>q.title)});
  return {queued,skipped,restartRequired:queued.length>0};
 });
 app.get('/api/servers/:id/addons/unmanaged',async(req)=>{
  const {server,cap}=await context(req);
  if(!cap.supported)return {items:[]};
  mustBeWritable(server);
  const r:any=await syncOperation(server,'file.list',{path:cap.dir}).catch(()=>({items:[]}));
  const known=new Set((await tracked(server.id)).map(a=>diskName(a)));
  return {dir:cap.dir,items:(Array.isArray(r?.items)?r.items:[]).filter((i:any)=>i.type==='file'&&/\.jar(\.disabled)?$/i.test(i.name)&&!known.has(i.name)).map((i:any)=>({name:i.name,size:i.size,modifiedAt:i.modifiedAt,disabled:/\.disabled$/.test(i.name)}))};
 });
}
