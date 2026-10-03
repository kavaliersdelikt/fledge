import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,page} from '../core.js';
import {settings} from '../settings.js';
import {newer,parse} from '../updates.js';
import {ManifestError,describePermission} from './manifest.js';
import {readPackage,MAX_PACKAGE_BYTES} from './package.js';
import {fetchRegistry,downloadRegistryPackage,clearRegistryCache} from './registry.js';
import {hostHealth} from './host-client.js';
import {bundledPackages,installPackage,updatePackage,rollbackPlugin,removePlugin,setEnabled,saveSettings,publicPlugin,callPlugin,requirePlugin,panelVersion,atLeast,type Tier,type PluginRow} from './manager.js';

const rethrow=(e:unknown)=>{if(e instanceof ManifestError)fail(400,e.problems.join('; '));throw e;};
const perms=(ids:string[])=>ids.map(id=>({id,text:describePermission(id)}));

type StoreItem={id:string;name:string;version:string;description:string;author:string;license:string|null;homepage:string|null;icon:string|null;tier:Tier;source:'bundled'|'registry';permissions:{id:string;text:string}[];catalogs:{id:string;label:string;kind:string}[];compatible:boolean;incompatibleReason:string|null;installed:null|{version:string;enabled:boolean;tier:Tier;updateAvailable:boolean};installable:boolean;blockedReason:string|null};

async function storeItems(force:boolean){
 const cfg=(await settings()).plugins,reg=await fetchRegistry(force);
 const installed=new Map<string,PluginRow>((await pool.query('SELECT * FROM plugins')).rows.map((r:PluginRow)=>[r.id,r]));
 const items:StoreItem[]=[];
 const mark=(id:string,version:string)=>{const p=installed.get(id);return p?{version:p.version,enabled:p.enabled,tier:p.tier,updateAvailable:!!parse(version)&&!!parse(p.version)&&newer(version,p.version)}:null;};
 for(const b of bundledPackages()){
  const m=b.manifest,bad=m.minPanelVersion&&!atLeast(panelVersion(),m.minPanelVersion);
  items.push({id:m.id,name:m.name,version:m.version,description:m.description,author:m.author,license:m.license,homepage:m.homepage||null,icon:b.icon,tier:'bundled',source:'bundled',permissions:perms(m.permissions),catalogs:m.catalogs,compatible:!bad,incompatibleReason:bad?`Needs Fledge ${m.minPanelVersion}`:null,installed:mark(m.id,m.version),installable:!bad,blockedReason:null});
 }
 for(const e of reg.entries){
  if(items.some(i=>i.id===e.id))continue;
  const bad=e.minPanelVersion&&!atLeast(panelVersion(),e.minPanelVersion);
  const tier:Tier=e.verified?'verified':'community';
  const blocked=tier==='community'&&!cfg.allowCommunity?'Unsigned community plugins are turned off (Settings → Plugins)':null;
  items.push({id:e.id,name:e.name,version:e.version,description:e.description,author:e.author,license:e.license||null,homepage:e.homepage||null,icon:e.icon||null,tier,source:'registry',permissions:perms(e.permissions),catalogs:[],compatible:!bad,incompatibleReason:bad?`Needs Fledge ${e.minPanelVersion}`:null,installed:mark(e.id,e.version),installable:!bad&&!blocked,blockedReason:blocked});
 }
 return {items,registry:{url:reg.url,error:reg.error,fetchedAt:reg.fetchedAt,entries:reg.entries.length},allowCommunity:cfg.allowCommunity};
}

async function obtain(source:string,id:string|undefined,upload:unknown,allowCommunity:boolean){
 if(source==='bundled'){
  const pkg=bundledPackages().find(b=>b.manifest.id===id);
  if(!pkg)fail(404,'That bundled plugin does not exist');
  return {pkg:pkg!,tier:'bundled' as Tier,source:'bundled'};
 }
 if(source==='registry'){
  const reg=await fetchRegistry(false),entry=reg.entries.find(e=>e.id===id);
  if(!entry)fail(404,'That plugin is not in the registry');
  const {pkg,verified}=await downloadRegistryPackage(entry!);
  const tier:Tier=verified?'verified':'community';
  if(tier==='community'&&!allowCommunity)fail(403,'Unsigned community plugins are turned off. An administrator can allow them in Settings → Plugins.');
  return {pkg,tier,source:'registry'};
 }
 if(source==='upload'){
  if(!allowCommunity)fail(403,'Uploading plugin packages needs community plugins turned on in Settings → Plugins.');
  if(typeof upload!=='string'||upload.length>Math.ceil(MAX_PACKAGE_BYTES*1.4)+16)fail(413,'The package is missing or too large');
  let bytes:Buffer;try{bytes=Buffer.from(upload as string,'base64');}catch{return fail(400,'The package is not valid base64');}
  try{return {pkg:readPackage(bytes),tier:'community' as Tier,source:'upload'};}catch(e){return rethrow(e);}
 }
 return fail(400,'source must be bundled, registry or upload');
}

export function pluginRoutes(app:FastifyInstance){
 app.get('/api/plugins',async(req)=>{
  admin(req);
  const rows=(await pool.query('SELECT * FROM plugins ORDER BY name')).rows as PluginRow[];
  return {host:await hostHealth(),plugins:rows.map(r=>({...publicPlugin(r),readme:undefined,changelog:undefined}))};
 });
 app.get('/api/plugins/store',async(req)=>{admin(req);const refresh=(req.query as any)?.refresh==='1';if(refresh)clearRegistryCache();return storeItems(refresh);});
 app.get('/api/plugins/host',async(req)=>{admin(req);return hostHealth();});
 app.get('/api/plugins/:id',async(req)=>{admin(req);return publicPlugin(await requirePlugin((req.params as any).id));});
 app.post('/api/plugins',async(req)=>{
  admin(req);
  const b=req.body as any,cfg=(await settings()).plugins;
  const got=await obtain(String(b?.source||''),typeof b?.id==='string'?b.id:undefined,b?.package,cfg.allowCommunity);
  try{
   const row=await installPackage(got.pkg,{tier:got.tier,source:got.source,actor:req.actor!.id,accept:b?.acceptPermissions===true});
   return publicPlugin(row);
  }catch(e){return rethrow(e);}
 });
 // Look inside a package (upload) or registry entry without installing anything, so the admin sees what it asks for first.
 app.post('/api/plugins/inspect',async(req)=>{
  admin(req);
  const b=req.body as any,cfg=(await settings()).plugins;
  const got=await obtain(String(b?.source||''),typeof b?.id==='string'?b.id:undefined,b?.package,true);
  const m=got.pkg.manifest,cur=await pool.query('SELECT version,tier FROM plugins WHERE id=$1',[m.id]);
  return {id:m.id,name:m.name,version:m.version,description:m.description,author:m.author,license:m.license,homepage:m.homepage||null,icon:got.pkg.icon,tier:got.tier,source:got.source,permissions:perms(m.permissions),catalogs:m.catalogs,settingsSchema:m.settings,installed:cur.rows[0]||null,
   blockedReason:got.tier==='community'&&!cfg.allowCommunity?'Unsigned community plugins are turned off (Settings → Plugins)':null};
 });
 app.post('/api/plugins/:id/update',async(req)=>{
  admin(req);
  const id=(req.params as any).id,cur=await requirePlugin(id),b=req.body as any,cfg=(await settings()).plugins;
  const got=await obtain(cur.source==='upload'?'upload':cur.source,id,b?.package,cfg.allowCommunity);
  if(got.pkg.manifest.id!==id)fail(400,'That package is a different plugin');
  try{return publicPlugin(await updatePackage(got.pkg,{tier:got.tier,source:got.source,actor:req.actor!.id,accept:b?.acceptPermissions===true}));}catch(e){return rethrow(e);}
 });
 app.post('/api/plugins/:id/rollback',async(req)=>{admin(req);return publicPlugin(await rollbackPlugin((req.params as any).id,req.actor!.id));});
 app.patch('/api/plugins/:id',async(req)=>{
  admin(req);
  const b=req.body as any;
  if(typeof b?.enabled!=='boolean')fail(400,'enabled must be true or false');
  return publicPlugin(await setEnabled((req.params as any).id,b.enabled,req.actor!.id));
 });
 app.put('/api/plugins/:id/settings',async(req)=>{admin(req);return publicPlugin(await saveSettings((req.params as any).id,req.body,req.actor!.id));});
 app.delete('/api/plugins/:id',async(req)=>{admin(req);await removePlugin((req.params as any).id,req.actor!.id);return {ok:true};});
 app.get('/api/plugins/:id/logs',async(req)=>{
  admin(req);
  const id=(req.params as any).id;await requirePlugin(id);const p=page(req.query);
  return (await pool.query('SELECT id,level,message,at FROM plugin_logs WHERE plugin_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3',[id,p.limit,p.offset])).rows;
 });
 app.post('/api/plugins/:id/health',async(req)=>{
  admin(req);
  const id=(req.params as any).id;await requirePlugin(id);
  try{
   const r:any=await callPlugin(id,'healthCheck',[],{allowDisabled:true,limits:{deadlineMs:15000}});
   return {ok:r?.ok!==false,message:typeof r?.message==='string'?r.message.slice(0,300):'The plugin answered'};
  }catch(e:any){
   if(/does not implement/.test(e?.message||''))return {ok:true,message:'The plugin has no health check; it loaded fine.'};
   return {ok:false,message:String(e?.message||'The plugin failed').slice(0,300)};
  }
 });
}
