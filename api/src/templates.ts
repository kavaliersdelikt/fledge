import type {FastifyInstance} from 'fastify';
import {pool,admin,scope,fail,txt,positive,asId,audit,queueRecreate,serverAccess} from './core.js';
import {imageAllowed} from './settings.js';
import {safeTest,validPattern} from './saferegex.js';
import {panelVersion} from './plugins/manager.js';

// Templates: what a game server is made of (image, ports, environment) and which of its
// variables owners may change. Variables are typed so the panel can show the right input and
// the API can refuse nonsense. Every change to a template creates a new version, so servers
// can be brought up to date on purpose instead of drifting.

export type VariableDef={key:string;label:string;description?:string;type:'string'|'number'|'boolean'|'select';options?:{value:string;label:string}[];min?:number;max?:number;pattern?:string;secret?:boolean;userEditable:boolean;required?:boolean};
const KEY=/^[A-Z_][A-Z0-9_]*$/;

/** Validates variable definitions submitted with a template. */
export function validateDefs(raw:unknown):VariableDef[]{
 if(raw===undefined||raw===null)return [];
 if(!Array.isArray(raw)||raw.length>40)fail(400,'variables must be a list of at most 40 definitions');
 const out:VariableDef[]=[];
 for(const d of raw as any[]){
  if(!d||typeof d!=='object')fail(400,'Each variable must be an object');
  const key=String(d.key||'');
  if(!KEY.test(key)||key.length>64)fail(400,`“${key.slice(0,40)}” is not a valid variable name (CAPITAL_LETTERS_AND_DIGITS)`);
  if(out.some(x=>x.key===key))fail(400,`Variable ${key} is defined twice`);
  if(!['string','number','boolean','select'].includes(d.type))fail(400,`Variable ${key} has an unknown type`);
  const def:VariableDef={key,label:(typeof d.label==='string'&&d.label.trim()?d.label.trim():key).slice(0,80),type:d.type,userEditable:d.userEditable===true};
  if(typeof d.description==='string'&&d.description)def.description=d.description.slice(0,300);
  if(d.secret===true)def.secret=true;
  if(d.required===true)def.required=true;
  if(d.type==='select'){
   if(!Array.isArray(d.options)||!d.options.length||d.options.length>60||d.options.some((o:any)=>typeof o?.value!=='string'||o.value.length>200))fail(400,`Variable ${key} needs a list of options`);
   def.options=d.options.map((o:any)=>({value:o.value,label:(typeof o.label==='string'&&o.label?o.label:o.value).slice(0,100)}));
  }
  for(const f of ['min','max'] as const)if(d[f]!==undefined){if(typeof d[f]!=='number'||!Number.isFinite(d[f]))fail(400,`Variable ${key}: ${f} must be a number`);def[f]=d[f];}
  if(d.pattern!==undefined){
   if(typeof d.pattern!=='string'||d.pattern.length>200)fail(400,`Variable ${key}: invalid pattern`);
   if(!validPattern(d.pattern))fail(400,`Variable ${key}: the pattern is not a valid regular expression (at most 200 characters)`);
   def.pattern=d.pattern;
  }
  out.push(def);
 }
 return out;
}

/** The typed definitions in force for a template: explicit ones plus legacy editableVariables as plain text fields. */
export function effectiveDefs(t:{variables?:VariableDef[];editable_variables?:string[]}):VariableDef[]{
 const defs=[...(Array.isArray(t.variables)?t.variables:[])];
 for(const k of t.editable_variables||[])if(!defs.some(d=>d.key===k))defs.push({key:k,label:k,type:'string',userEditable:true});
 return defs;
}

/** Checks one submitted value against its definition and returns it as the string stored on the server. */
export function checkValue(def:VariableDef,raw:unknown):string{
 const label=def.label||def.key;
 if(typeof raw==='number'||typeof raw==='boolean')raw=String(raw);
 if(typeof raw!=='string'||raw.length>4096)fail(400,`${label} must be text up to 4096 characters`);
 const v=raw as string;
 if(v===''){if(def.required)fail(400,`${label} is required`);return v;}
 switch(def.type){
  case 'number':{
   const n=Number(v);
   if(!Number.isFinite(n)||!/^-?\d+(\.\d+)?$/.test(v.trim()))fail(400,`${label} must be a number`);
   if(def.min!==undefined&&n<def.min)fail(400,`${label} must be at least ${def.min}`);
   if(def.max!==undefined&&n>def.max)fail(400,`${label} must be at most ${def.max}`);
   return v.trim();}
  case 'boolean':
   if(!['true','false','TRUE','FALSE','1','0'].includes(v))fail(400,`${label} must be on or off`);
   return v;
  case 'select':
   if(!def.options?.some(o=>o.value===v))fail(400,`${label} must be one of: ${def.options?.map(o=>o.value).join(', ')}`);
   return v;
  default:
   if(def.min!==undefined&&v.length<def.min)fail(400,`${label} must be at least ${def.min} characters`);
   if(def.max!==undefined&&v.length>def.max)fail(400,`${label} must be at most ${def.max} characters`);
   if(def.pattern&&!safeTest(def.pattern,v))fail(400,`${label} has an invalid format`);
   return v;
 }
}

// --- Template bodies -----------------------------------------------------------------------
async function parseBody(b:any,existing?:any){
 if(!b||typeof b!=='object')fail(400,'Expected an object');
 const pick=<T>(name:string,fallback:T):T=>b[name]!==undefined?b[name]:fallback;
 const ports=pick('internalPorts',existing?.internal_ports);
 if(!Array.isArray(ports)||ports.length<1||ports.length>10||ports.some((p:any)=>!Number.isInteger(p.container)||p.container<1||p.container>65535||!Number.isInteger(p.offset)||p.offset<0||p.offset>100||!['tcp','udp'].includes(p.protocol)))fail(400,'Invalid internalPorts');
 const image=txt(pick('image',existing?.image),256);
 if(!/^[\w./:@-]+$/.test(image)||image.includes('..'))fail(400,'Invalid image name');
 if(!(await imageAllowed(image)))fail(403,'Image is not on the allowed list (Settings → Nodes)');
 const env=pick('env',existing?.env||{});
 if(typeof env!=='object'||env===null||Array.isArray(env)||Object.entries(env).some(([k,v])=>!KEY.test(k)||typeof v!=='string'||(v as string).length>4096))fail(400,'Invalid env');
 const editable=pick('editableVariables',existing?.editable_variables||[]);
 if(!Array.isArray(editable)||editable.length>40||editable.some((v:any)=>typeof v!=='string'||!KEY.test(v)))fail(400,'Invalid editableVariables');
 const variables=validateDefs(pick('variables',existing?.variables||[]));
 const quick=pick('quickCommands',existing?.quick_commands||[]);
 if(!Array.isArray(quick)||quick.length>20||quick.some((q:any)=>typeof q?.label!=='string'||typeof q?.command!=='string'||!q.label||!q.command||q.label.length>40||q.command.length>256||/[\r\n\0]/.test(q.command)))fail(400,'Invalid quickCommands');
 const addons=pick('addons',existing?.addons??null);
 if(addons!==null){
  if(typeof addons!=='object'||Array.isArray(addons)||typeof addons.types!=='object'||addons.types===null)fail(400,'Invalid addons (expected {types:{TYPE:{kind,dir,loaders}}})');
  for(const [t,r] of Object.entries<any>(addons.types))if(!/^[A-Z0-9_]{1,40}$/.test(t)||!r||!/^[a-z][a-z0-9-]{0,30}$/.test(String(r.kind))||!/^\/[A-Za-z0-9_./-]{1,100}$/.test(String(r.dir))||r.dir.includes('..')||!Array.isArray(r.loaders)||r.loaders.length>12||r.loaders.some((l:any)=>!/^[a-z0-9-]{1,30}$/.test(String(l))))fail(400,`Invalid add-on rule for ${t.slice(0,40)}`);
  if(addons.versionVar!==undefined&&!KEY.test(String(addons.versionVar)))fail(400,'Invalid addons.versionVar');
  if(addons.typeVar!==undefined&&!KEY.test(String(addons.typeVar)))fail(400,'Invalid addons.typeVar');
 }
 const stop=pick('stopCommand',existing?.stop_command??null);
 const startup=pick('startup',existing?.startup??null);
 return {name:txt(pick('name',existing?.name),80),description:typeof b.description==='string'?b.description.slice(0,500):(existing?.description??null),image,startup:startup?txt(startup,4096):null,stop:stop?txt(stop,256):null,ports,env,editable,variables,quick,addons,
  memory:positive(pick('memoryMb',existing?.memory_mb??2048)),cpu:positive(pick('cpuPercent',existing?.cpu_percent??100)),disk:positive(pick('diskMb',existing?.disk_mb??10240))};
}
// Key order is not meaningful in JSON columns, so compare canonical forms.
const canon=(v:any):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const snapshot=(t:any)=>({image:t.image,startup:t.startup,stopCommand:t.stop_command,internalPorts:t.internal_ports,env:t.env});
const shape=(t:any,isAdmin:boolean)=>({id:t.id,name:t.name,description:t.description,image:t.image,startup:isAdmin?t.startup:null,internalPorts:t.internal_ports,env:isAdmin?t.env:Object.fromEntries(Object.keys(t.env).map(k=>[k,'[configured]'])),memoryMb:t.memory_mb,cpuPercent:t.cpu_percent,diskMb:t.disk_mb,
 editableVariables:t.editable_variables,variables:effectiveDefs(t).map(d=>isAdmin?d:{...d}),stopCommand:t.stop_command,official:t.official,version:t.version,addons:t.addons,quickCommands:t.quick_commands,updatedAt:t.updated_at});

export function templateRoutes(app:FastifyInstance){
 app.get('/api/templates',async(req)=>{
  const rows=(await pool.query('SELECT * FROM templates ORDER BY official DESC,name')).rows;
  const isAdmin=req.actor?.role==='admin'&&!req.actor.tokenScopes;
  return rows.map(t=>shape(t,isAdmin));
 });
 app.post('/api/templates',async(req)=>{
  admin(req);scope(req,'provision');
  const b=req.body as any,id=txt(b?.id,64);
  if(!/^[a-z0-9][a-z0-9-]*$/.test(id))fail(400,'Template ID must be lowercase alphanumeric/hyphen');
  const p=await parseBody(b);
  const r=(await pool.query('INSERT INTO templates(id,name,description,image,startup,stop_command,internal_ports,env,memory_mb,cpu_percent,disk_mb,editable_variables,variables,quick_commands,addons) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
   [id,p.name,p.description,p.image,p.startup,p.stop,JSON.stringify(p.ports),JSON.stringify(p.env),p.memory,p.cpu,p.disk,p.editable,JSON.stringify(p.variables),JSON.stringify(p.quick),p.addons===null?null:JSON.stringify(p.addons)])).rows[0];
  await pool.query('INSERT INTO template_versions(template_id,version,snapshot,created_by) VALUES($1,1,$2,$3)',[id,JSON.stringify(snapshot(r)),req.actor!.id]);
  await audit(req.actor!.id,'template.create','template',id);
  return shape(r,true);
 });
 app.put('/api/templates/:id',async(req)=>{
  admin(req);scope(req,'provision');
  const id=txt((req.params as any).id,64),c=await pool.connect();
  try{
   await c.query('BEGIN');
   const cur=(await c.query('SELECT * FROM templates WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!cur)fail(404,'Template not found');
   const p=await parseBody(req.body,cur);
   const changed=canon(snapshot({...cur,image:p.image,startup:p.startup,stop_command:p.stop,internal_ports:p.ports,env:p.env}))!==canon(snapshot(cur));
   const version=changed?cur.version+1:cur.version;
   const r=(await c.query('UPDATE templates SET name=$2,description=$3,image=$4,startup=$5,stop_command=$6,internal_ports=$7,env=$8,memory_mb=$9,cpu_percent=$10,disk_mb=$11,editable_variables=$12,variables=$13,quick_commands=$14,addons=$15,version=$16,updated_at=now() WHERE id=$1 RETURNING *',
    [id,p.name,p.description,p.image,p.startup,p.stop,JSON.stringify(p.ports),JSON.stringify(p.env),p.memory,p.cpu,p.disk,p.editable,JSON.stringify(p.variables),JSON.stringify(p.quick),p.addons===null?null:JSON.stringify(p.addons),version])).rows[0];
   if(changed)await c.query('INSERT INTO template_versions(template_id,version,snapshot,created_by) VALUES($1,$2,$3,$4)',[id,version,JSON.stringify(snapshot(r)),req.actor!.id]);
   await c.query('COMMIT');
   await audit(req.actor!.id,'template.update','template',id,{version,runtimeChanged:changed});
   return shape(r,true);
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 });
 app.delete('/api/templates/:id',async(req)=>{
  admin(req);scope(req,'provision');
  const id=txt((req.params as any).id,64),t=(await pool.query('SELECT official FROM templates WHERE id=$1',[id])).rows[0];
  if(!t)fail(404,'Template not found');
  if(t.official)fail(409,'Preinstalled templates cannot be deleted');
  const used=(await pool.query('SELECT count(*)::int n FROM servers WHERE template_id=$1 AND deleted_at IS NULL',[id])).rows[0].n;
  if(used)fail(409,`${used} server${used===1?' uses':'s use'} this template; delete or move them first`);
  try{await pool.query('DELETE FROM templates WHERE id=$1',[id]);}catch(e:any){if(e?.code==='23503')fail(409,'Deleted servers still reference this template');throw e;}
  await audit(req.actor!.id,'template.delete','template',id);
  return {ok:true};
 });
 app.get('/api/templates/:id/export',async(req)=>{
  admin(req);
  const id=txt((req.params as any).id,64),t=(await pool.query('SELECT * FROM templates WHERE id=$1',[id])).rows[0];
  if(!t)fail(404,'Template not found');
  const s=shape(t,true) as any;
  const keepEnv=(req.query as any)?.includeEnv!=='0';
  return {format:'fledge-template',formatVersion:1,exportedAt:new Date().toISOString(),fledgeVersion:panelVersion(),
   template:{id:s.id,name:s.name,description:s.description,image:s.image,startup:s.startup,stopCommand:s.stopCommand,internalPorts:s.internalPorts,env:keepEnv?s.env:{},memoryMb:s.memoryMb,cpuPercent:s.cpuPercent,diskMb:s.diskMb,editableVariables:s.editableVariables,variables:t.variables,quickCommands:s.quickCommands,addons:s.addons}};
 });
 app.post('/api/templates/import',async(req)=>{
  admin(req);scope(req,'provision');
  const b=req.body as any,doc=b?.document;
  if(!doc||doc.format!=='fledge-template'||doc.formatVersion!==1||!doc.template||typeof doc.template!=='object')fail(400,'This is not a Fledge template export (format "fledge-template", version 1)');
  const body={...doc.template};
  const id=txt(typeof b.id==='string'&&b.id?b.id:body.id,64);
  if(!/^[a-z0-9][a-z0-9-]*$/.test(id))fail(400,'Template ID must be lowercase alphanumeric/hyphen');
  const existing=(await pool.query('SELECT * FROM templates WHERE id=$1',[id])).rows[0];
  if(existing&&b.overwrite!==true)fail(409,`A template with the ID “${id}” already exists. Choose another ID or allow overwriting.`);
  if(existing&&existing.official&&b.overwrite!==true)fail(409,'Preinstalled templates can only be overwritten explicitly');
  const p=await parseBody(body);
  const warnings:string[]=[];
  if(doc.fledgeVersion&&doc.fledgeVersion!==panelVersion())warnings.push(`Exported from Fledge ${String(doc.fledgeVersion).slice(0,20)}; this panel is ${panelVersion()}.`);
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   let row;
   if(existing){
    const changed=canon(snapshot({...existing,image:p.image,startup:p.startup,stop_command:p.stop,internal_ports:p.ports,env:p.env}))!==canon(snapshot(existing));
    const version=changed?existing.version+1:existing.version;
    row=(await c.query('UPDATE templates SET name=$2,description=$3,image=$4,startup=$5,stop_command=$6,internal_ports=$7,env=$8,memory_mb=$9,cpu_percent=$10,disk_mb=$11,editable_variables=$12,variables=$13,quick_commands=$14,addons=$15,version=$16,updated_at=now() WHERE id=$1 RETURNING *',[id,p.name,p.description,p.image,p.startup,p.stop,JSON.stringify(p.ports),JSON.stringify(p.env),p.memory,p.cpu,p.disk,p.editable,JSON.stringify(p.variables),JSON.stringify(p.quick),p.addons===null?null:JSON.stringify(p.addons),version])).rows[0];
    if(changed)await c.query('INSERT INTO template_versions(template_id,version,snapshot,created_by) VALUES($1,$2,$3,$4)',[id,version,JSON.stringify(snapshot(row)),req.actor!.id]);
   }else{
    row=(await c.query('INSERT INTO templates(id,name,description,image,startup,stop_command,internal_ports,env,memory_mb,cpu_percent,disk_mb,editable_variables,variables,quick_commands,addons) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',[id,p.name,p.description,p.image,p.startup,p.stop,JSON.stringify(p.ports),JSON.stringify(p.env),p.memory,p.cpu,p.disk,p.editable,JSON.stringify(p.variables),JSON.stringify(p.quick),p.addons===null?null:JSON.stringify(p.addons)])).rows[0];
    await c.query('INSERT INTO template_versions(template_id,version,snapshot,created_by) VALUES($1,1,$2,$3)',[id,JSON.stringify(snapshot(row)),req.actor!.id]);
   }
   await c.query('COMMIT');
   await audit(req.actor!.id,'template.import','template',id,{overwrite:!!existing});
   return {template:shape(row,true),warnings};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 });

 // Which servers run an older version of their template, and what would change for them.
 const outdated=async(templateId:string)=>{
  const t=(await pool.query('SELECT * FROM templates WHERE id=$1',[templateId])).rows[0];
  if(!t)fail(404,'Template not found');
  const servers=(await pool.query("SELECT s.id,s.name,s.template_version,s.node_id,s.observed_status,u.email AS owner_email,n.status AS node_status FROM servers s JOIN users u ON u.id=s.owner_id JOIN nodes n ON n.id=s.node_id WHERE s.template_id=$1 AND s.deleted_at IS NULL AND s.template_version<$2 ORDER BY s.name",[templateId,t.version])).rows;
  const history=new Map((await pool.query('SELECT version,snapshot FROM template_versions WHERE template_id=$1',[templateId])).rows.map((r:any)=>[r.version,r.snapshot]));
  const now=snapshot(t);
  const out=servers.map((s:any)=>{
   const old=history.get(s.template_version);
   const changes:string[]=[];
   if(old){
    for(const k of ['image','startup','stopCommand'] as const)if(JSON.stringify(old[k])!==JSON.stringify(now[k]))changes.push(k==='stopCommand'?'stop command':k);
    const added=Object.keys(now.env).filter(k=>JSON.stringify(old.env?.[k])!==JSON.stringify(now.env[k]));
    if(added.length)changes.push(`environment (${added.slice(0,6).join(', ')}${added.length>6?'…':''})`);
    if(canon(old.internalPorts)!==canon(now.internalPorts))changes.push('ports');
   }
   const portsChanged=changes.includes('ports');
   return {id:s.id,name:s.name,ownerEmail:s.owner_email,fromVersion:s.template_version,toVersion:t.version,changes:changes.length?changes:['no runtime change'],canApply:!portsChanged&&s.node_status==='connected',blocker:portsChanged?'The port layout changed; recreate this server to use it':s.node_status!=='connected'?'The node is offline':null};
  });
  return {template:{id:t.id,name:t.name,version:t.version},servers:out};
 };
 app.get('/api/templates/:id/outdated',async(req)=>{admin(req);return outdated(txt((req.params as any).id,64));});
 app.post('/api/templates/:id/apply',async(req)=>{
  admin(req);scope(req,'provision');
  const b=req.body as any;
  if(b?.confirm!==true)fail(400,'Applying a template recreates each server’s container; send {confirm:true}');
  const id=txt((req.params as any).id,64),o=await outdated(id);
  const wanted=Array.isArray(b?.serverIds)?new Set<string>(b.serverIds.map((x:unknown)=>asId(x))):null;
  const queued:string[]=[],skipped:{id:string;reason:string}[]=[];
  for(const s of o.servers){
   if(wanted&&!wanted.has(s.id))continue;
   if(!s.canApply){skipped.push({id:s.id,reason:s.blocker||'Cannot be applied'});continue;}
   const row=(await pool.query("UPDATE servers SET template_version=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND observed_status<>'deleting' RETURNING id,node_id,desired_status,suspended",[s.id,o.template.version])).rows[0];
   if(!row)continue;
   await queueRecreate(pool,row);
   queued.push(s.id);
  }
  await audit(req.actor!.id,'template.apply','template',id,{servers:queued.length,version:o.template.version});
  return {queued:queued.length,skipped};
 });

 // What a server actually starts with, for the "Startup" panel.
 app.get('/api/servers/:id/startup',async(req)=>{
  const s=await serverAccess(req,(req.params as any).id);
  const t=(await pool.query('SELECT * FROM templates WHERE id=$1',[s.template_id])).rows[0];
  const defs=effectiveDefs(t),canManage=req.actor?.role==='admin'||s.owner_id===req.actor?.id||(s.permissions||[]).includes('manage');
  const isAdmin=req.actor?.role==='admin'&&!req.actor.tokenScopes;
  const secretish=(k:string)=>defs.find(d=>d.key===k)?.secret===true||/(PASS|PASSWORD|SECRET|TOKEN|KEY)$/.test(k);
  const merged=new Map<string,{value:string;source:'template'|'server'}>();
  // Template-level environment is an operator's configuration: customers only see values a declared variable surfaces.
  for(const [k,v] of Object.entries<string>(t.env))if(isAdmin||defs.some(d=>d.key===k))merged.set(k,{value:v,source:'template'});
  for(const [k,v] of Object.entries<string>(s.variables||{}))merged.set(k,{value:v,source:'server'});
  const env=[...merged.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,m])=>{
   const def=defs.find(d=>d.key===key),hide=secretish(key)&&!isAdmin;
   return {key,value:hide?null:m.value,hidden:hide,source:m.source,editable:!!def?.userEditable&&canManage,label:def?.label||null,type:def?.type||null};
  });
  const hideCommand=!isAdmin;
  return {image:s.image,startup:hideCommand?null:t.startup,stopCommand:t.stop_command,env,ports:[{base:s.port,mapping:(t.internal_ports as any[]).map(p=>({host:s.port+p.offset,container:p.container,protocol:p.protocol}))}],
   templateId:t.id,templateName:t.name,templateVersion:s.template_version,currentTemplateVersion:t.version,outdated:s.template_version<t.version,variables:defs.filter(d=>d.userEditable).map(d=>d.secret&&!isAdmin?{...d,default:undefined}:d)};
 });
}
