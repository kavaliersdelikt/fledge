import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve,sep} from 'node:path';
import {pool,fail,audit,encrypt,decrypt} from '../core.js';
import {emit} from '../notifications.js';
import {parse,newer} from '../updates.js';
import {validateManifest,validateSettings,networkHosts,describePermission,ManifestError,type Manifest} from './manifest.js';
import {sha256,type PluginPackage} from './package.js';
import {invokeHost,HostUnavailable} from './host-client.js';

// Installing, configuring and running plugins. Plugin code only ever executes in the
// plugin host; this module decides whether, with what settings, and what happens to the result.

export type Tier='bundled'|'verified'|'community';
export const panelVersion=()=> (process.env.APP_VERSION||'0.7.2.1').replace(/^v/i,'');
export const atLeast=(have:string,need:string)=>have===need||newer(have,need);
const AUTO_DISABLE_AFTER=5;
const FATAL_CODES=new Set(['timeout','script-error','too-large','host-error','bad-method']);

// --- Bundled plugins -----------------------------------------------------------------
export const bundledDir=()=>process.env.BUNDLED_PLUGINS_DIR||fileURLToPath(new URL('../../../plugins/bundled',import.meta.url));
/** Reads plugins/bundled/<name>: fledge-plugin.json, plugin.js, optional shared includes. */
export function readBundled(dir:string):PluginPackage{
 const root=resolve(dir),base=resolve(bundledDir());
 const raw=JSON.parse(readFileSync(join(root,'fledge-plugin.json'),'utf8'));
 const manifest=validateManifest(raw);
 const parts:string[]=[];
 for(const inc of Array.isArray(raw.include)?raw.include:[]){
  const file=resolve(root,String(inc));
  if(!file.startsWith(base+sep))throw new Error(`Bundled plugin ${manifest.id} includes a file outside the bundled directory`);
  parts.push(readFileSync(file,'utf8'));
 }
 parts.push(readFileSync(join(root,'plugin.js'),'utf8'));
 const code=parts.join('\n;\n');
 const read=(n:string)=>existsSync(join(root,n))?readFileSync(join(root,n),'utf8'):null;
 const svg=read('icon.svg');
 return {manifest,code,codeSha256:sha256(code),packageSha256:sha256(code+JSON.stringify(manifest)),icon:svg?`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`:null,readme:read('README.md'),changelog:read('CHANGELOG.md')};
}
let bundledCache:PluginPackage[]|undefined;
export function bundledPackages():PluginPackage[]{
 if(bundledCache)return bundledCache;
 const base=bundledDir();const out:PluginPackage[]=[];
 if(existsSync(base))for(const e of readdirSync(base,{withFileTypes:true})){
  if(!e.isDirectory()||e.name.startsWith('_')||!existsSync(join(base,e.name,'fledge-plugin.json')))continue;
  try{out.push(readBundled(join(base,e.name)));}catch(err:any){console.error(`Bundled plugin ${e.name} is invalid: ${err?.message}`);}
 }
 return bundledCache=out;
}

// --- Rows ----------------------------------------------------------------------------
export type PluginRow={id:string;name:string;version:string;tier:Tier;source:string;manifest:Manifest;code:string;code_sha256:string;package_sha256:string|null;icon:string|null;readme:string|null;changelog:string|null;enabled:boolean;granted_permissions:string[];settings:Record<string,unknown>;secrets:string|null;previous:any;failure_count:number;last_error:string|null;disabled_reason:string|null;installed_at:string;updated_at:string};
export async function getPlugin(id:string):Promise<PluginRow|undefined>{return (await pool.query('SELECT * FROM plugins WHERE id=$1',[id])).rows[0];}
export async function requirePlugin(id:string){const p=await getPlugin(id);if(!p)fail(404,'Plugin not found');return p!;}
const storedSecrets=(p:PluginRow):Record<string,string>=>{if(!p.secrets)return {};try{return JSON.parse(decrypt(p.secrets));}catch{return {};}};
const missingRequired=(p:PluginRow)=>{
 const secrets=storedSecrets(p);
 return p.manifest.settings.filter(f=>f.required&&(f.type==='secret'?!secrets[f.key]:p.settings[f.key]===undefined&&f.default===undefined)).map(f=>f.label);
};
const unaccepted=(manifest:Manifest,granted:string[])=>manifest.permissions.filter(p=>!granted.includes(p));

export function publicPlugin(p:PluginRow){
 const secrets=storedSecrets(p);
 return {
  id:p.id,name:p.name,version:p.version,tier:p.tier,source:p.source,description:p.manifest.description,author:p.manifest.author,license:p.manifest.license,homepage:p.manifest.homepage||null,
  icon:p.icon,enabled:p.enabled,catalogs:p.manifest.catalogs,hooks:p.manifest.hooks,payments:p.manifest.payments||null,
  permissions:p.manifest.permissions.map(id=>({id,text:describePermission(id),granted:p.granted_permissions.includes(id)})),
  settingsSchema:p.manifest.settings,
  settings:Object.fromEntries(p.manifest.settings.map(f=>[f.key,f.type==='secret'?{set:!!secrets[f.key]}:(p.settings[f.key]??f.default??null)])),
  missingSettings:missingRequired(p),failureCount:p.failure_count,lastError:p.last_error,disabledReason:p.disabled_reason,
  hasPrevious:!!p.previous,previousVersion:p.previous?.version||null,installedAt:p.installed_at,updatedAt:p.updated_at,readme:p.readme,changelog:p.changelog,
 };
}

// --- Install, update, remove ---------------------------------------------------------
function checkCompatible(m:Manifest){
 if(m.minPanelVersion&&!atLeast(panelVersion(),m.minPanelVersion))fail(409,`This plugin needs Fledge ${m.minPanelVersion} or newer (this panel is ${panelVersion()})`);
}
async function insertLog(id:string,level:string,message:string){
 await pool.query('INSERT INTO plugin_logs(plugin_id,level,message) VALUES($1,$2,$3)',[id,level,message.slice(0,2000)]);
}
export async function installPackage(pkg:PluginPackage,o:{tier:Tier;source:string;actor:string|null;accept:boolean}){
 const m=pkg.manifest;
 checkCompatible(m);
 if(await getPlugin(m.id))fail(409,'This plugin is already installed; use update instead');
 if(!o.accept)fail(400,'Approve the permissions this plugin asks for to install it');
 await pool.query(`INSERT INTO plugins(id,name,version,tier,source,manifest,code,code_sha256,package_sha256,icon,readme,changelog,granted_permissions,installed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [m.id,m.name,m.version,o.tier,o.source,JSON.stringify(m),pkg.code,pkg.codeSha256,pkg.packageSha256,pkg.icon,pkg.readme,pkg.changelog,m.permissions,o.actor]);
 await audit(o.actor,'plugin.install','plugin',m.id,{version:m.version,tier:o.tier,source:o.source,permissions:m.permissions});
 return requirePlugin(m.id);
}
export async function updatePackage(pkg:PluginPackage,o:{tier:Tier;source:string;actor:string|null;accept:boolean}){
 const m=pkg.manifest,cur=await requirePlugin(m.id);
 checkCompatible(m);
 if(parse(m.version)&&parse(cur.version)&&newer(cur.version,m.version))fail(409,'That is an older version than the one installed; use rollback instead');
 const rank:Record<Tier,number>={community:0,verified:1,bundled:2};
 if(rank[o.tier]<rank[cur.tier]&&!o.accept)throw Object.assign(new Error(`This update is less trusted (${o.tier}) than the installed version (${cur.tier})`),{statusCode:409,error:'less_trusted',details:{from:cur.tier,to:o.tier}});
 const added=unaccepted(m,cur.granted_permissions);
 if(added.length&&!o.accept)throw Object.assign(new Error('This version asks for new permissions'),{statusCode:409,error:'permissions_changed',details:{newPermissions:added.map(id=>({id,text:describePermission(id)}))}});
 const previous={version:cur.version,manifest:cur.manifest,code:cur.code,code_sha256:cur.code_sha256,package_sha256:cur.package_sha256,icon:cur.icon,readme:cur.readme,changelog:cur.changelog,tier:cur.tier,source:cur.source,granted_permissions:cur.granted_permissions,settings:cur.settings,secrets:cur.secrets};
 // Settings the new version no longer declares are dropped; the rest are kept.
 const keep=new Set(m.settings.map(f=>f.key)),nextSettings=Object.fromEntries(Object.entries(cur.settings).filter(([k])=>keep.has(k)));
 const secrets=Object.fromEntries(Object.entries(storedSecrets(cur)).filter(([k])=>keep.has(k)));
 await pool.query(`UPDATE plugins SET name=$2,version=$3,tier=$4,source=$5,manifest=$6,code=$7,code_sha256=$8,package_sha256=$9,icon=$10,readme=$11,changelog=$12,granted_permissions=$13,settings=$14,secrets=$15,previous=$16,failure_count=0,last_error=NULL,disabled_reason=NULL,updated_at=now() WHERE id=$1`,
  [m.id,m.name,m.version,o.tier,o.source,JSON.stringify(m),pkg.code,pkg.codeSha256,pkg.packageSha256,pkg.icon,pkg.readme,pkg.changelog,m.permissions,JSON.stringify(nextSettings),Object.keys(secrets).length?encrypt(JSON.stringify(secrets)):null,JSON.stringify(previous)]);
 clearCatalogCache(m.id);
 await audit(o.actor,'plugin.update','plugin',m.id,{from:cur.version,to:m.version,newPermissions:added});
 return requirePlugin(m.id);
}
export async function rollbackPlugin(id:string,actor:string|null){
 const p=await requirePlugin(id);
 if(!p.previous)fail(409,'There is no previous version to roll back to');
 const v=p.previous;
 await pool.query(`UPDATE plugins SET name=$2,version=$3,tier=$4,source=$5,manifest=$6,code=$7,code_sha256=$8,package_sha256=$9,icon=$10,readme=$11,changelog=$12,granted_permissions=$13,settings=COALESCE($14::jsonb,settings),secrets=CASE WHEN $14::jsonb IS NULL THEN secrets ELSE $15 END,previous=NULL,failure_count=0,last_error=NULL,disabled_reason=NULL,updated_at=now() WHERE id=$1`,
  [id,v.manifest.name,v.version,v.tier,v.source,JSON.stringify(v.manifest),v.code,v.code_sha256,v.package_sha256,v.icon,v.readme,v.changelog,v.granted_permissions,v.settings?JSON.stringify(v.settings):null,v.secrets??null]);
 clearCatalogCache(id);
 await audit(actor,'plugin.rollback','plugin',id,{from:p.version,to:v.version});
 return requirePlugin(id);
}
export async function removePlugin(id:string,actor:string|null){
 await requirePlugin(id);
 await pool.query('DELETE FROM plugins WHERE id=$1',[id]);
 clearCatalogCache(id);
 await audit(actor,'plugin.uninstall','plugin',id);
}
export async function setEnabled(id:string,enabled:boolean,actor:string|null){
 const p=await requirePlugin(id);
 if(enabled){
  const missing=missingRequired(p);
  if(missing.length)fail(409,`Fill in the required settings first: ${missing.join(', ')}`);
  const need=unaccepted(p.manifest,p.granted_permissions);
  if(need.length)fail(409,'This plugin needs its new permissions approved first');
 }
 await pool.query('UPDATE plugins SET enabled=$2,failure_count=0,last_error=CASE WHEN $2 THEN NULL ELSE last_error END,disabled_reason=NULL,updated_at=now() WHERE id=$1',[id,enabled]);
 clearCatalogCache(id);
 await audit(actor,enabled?'plugin.enable':'plugin.disable','plugin',id);
 return requirePlugin(id);
}
export async function saveSettings(id:string,input:unknown,actor:string|null){
 const p=await requirePlugin(id);
 let result;
 try{result=validateSettings(p.manifest.settings,input,storedSecrets(p));}catch(e){if(e instanceof ManifestError)fail(400,e.problems.join('; '));throw e;}
 await pool.query('UPDATE plugins SET settings=$2,secrets=$3,updated_at=now() WHERE id=$1',[id,JSON.stringify(result.values),Object.keys(result.secrets).length?encrypt(JSON.stringify(result.secrets)):null]);
 clearCatalogCache(id);
 await audit(actor,'plugin.settings','plugin',id,{keys:Object.keys(result.values),secrets:Object.keys(result.secrets)});
 return requirePlugin(id);
}

/** Keeps bundled plugins in step with the panel image. New permissions are never granted silently. */
export async function syncBundled(){
 for(const pkg of bundledPackages()){
  const m=pkg.manifest,cur=await getPlugin(m.id);
  if(!cur||cur.source!=='bundled')continue;
  if(cur.code_sha256===pkg.codeSha256&&cur.version===m.version&&JSON.stringify(cur.manifest)===JSON.stringify(m))continue;
  const added=unaccepted(m,cur.granted_permissions);
  const keep=new Set(m.settings.map(f=>f.key)),nextSettings=Object.fromEntries(Object.entries(cur.settings).filter(([k])=>keep.has(k)));
  await pool.query(`UPDATE plugins SET name=$2,version=$3,manifest=$4,code=$5,code_sha256=$6,package_sha256=$7,icon=$8,readme=$9,changelog=$10,settings=$11,enabled=CASE WHEN $12::boolean THEN false ELSE enabled END,disabled_reason=CASE WHEN $12::boolean THEN 'The new version asks for permissions that need approval' ELSE disabled_reason END,updated_at=now() WHERE id=$1`,
   [m.id,m.name,m.version,JSON.stringify(m),pkg.code,pkg.codeSha256,pkg.packageSha256,pkg.icon,pkg.readme,pkg.changelog,JSON.stringify(nextSettings),added.length>0]);
  await audit(null,'plugin.sync','plugin',m.id,{from:cur.version,to:m.version});
 }
}

// --- Calling plugins -----------------------------------------------------------------
const catalogCache=new Map<string,{at:number;value:unknown}>();
export function clearCatalogCache(pluginId?:string){for(const k of [...catalogCache.keys()])if(!pluginId||k.startsWith(pluginId+'\u0000'))catalogCache.delete(k);}
export async function cachedCall<T>(pluginId:string,method:string,args:unknown[],ttlMs:number,opts:{allowDisabled?:boolean}={}):Promise<T>{
 const key=`${pluginId}\u0000${method}\u0000${JSON.stringify(args)}`,hit=catalogCache.get(key);
 if(hit&&Date.now()-hit.at<ttlMs)return hit.value as T;
 const value=await callPlugin<T>(pluginId,method,args,opts);
 catalogCache.set(key,{at:Date.now(),value});
 if(catalogCache.size>300)catalogCache.delete(catalogCache.keys().next().value as string);
 return value;
}

export async function callPlugin<T=unknown>(id:string,method:string,args:unknown[],opts:{allowDisabled?:boolean;limits?:Record<string,number>}={}):Promise<T>{
 const p=await getPlugin(id);
 if(!p)fail(404,'Plugin not found');
 if(!p!.enabled&&!opts.allowDisabled)fail(409,'This plugin is turned off');
 const granted=p!.granted_permissions,network=networkHosts(p!.manifest.permissions).filter(h=>granted.includes('network:'+h));
 const secrets=storedSecrets(p!);
 const kv:Record<string,unknown>={};
 if(granted.includes('storage'))for(const r of (await pool.query('SELECT key,value FROM plugin_kv WHERE plugin_id=$1',[id])).rows)kv[r.key]=r.value;
 const configured:Record<string,unknown>={};
 for(const f of p!.manifest.settings)configured[f.key]=f.type==='secret'?(secrets[f.key]??''):(p!.settings[f.key]??f.default??null);
 let out;
 try{out=await invokeHost({plugin:{id,version:p!.version},sha:p!.code_sha256,code:p!.code,method,args,settings:configured,storage:kv,storageAllowed:granted.includes('storage'),network,limits:opts.limits});}
 catch(e){
  if(e instanceof HostUnavailable)fail(503,e.message);
  throw e;
 }
 for(const l of out.logs.slice(0,100))await insertLog(id,l.level,l.message).catch(()=>{});
 await pool.query('DELETE FROM plugin_logs WHERE plugin_id=$1 AND id<(SELECT id FROM plugin_logs WHERE plugin_id=$1 ORDER BY id DESC OFFSET 499 LIMIT 1)',[id]).catch(()=>{});
 if(!out.ok){
  const fatal=FATAL_CODES.has(out.code);
  await insertLog(id,'error',`${method}: ${out.error}`).catch(()=>{});
  const r=await pool.query('UPDATE plugins SET failure_count=CASE WHEN $2 THEN failure_count+1 ELSE failure_count END,last_error=$3 WHERE id=$1 RETURNING failure_count',[id,fatal,out.error.slice(0,500)]);
  if(fatal&&r.rows[0]?.failure_count>=AUTO_DISABLE_AFTER){
   await pool.query("UPDATE plugins SET enabled=false,disabled_reason=$2 WHERE id=$1",[id,`Turned off automatically after ${AUTO_DISABLE_AFTER} consecutive failures: ${out.error.slice(0,200)}`]);
   await audit(null,'plugin.autodisable','plugin',id,{error:out.error.slice(0,200)});clearCatalogCache(id);void emit({kind:'plugin.disabled',title:`Plugin “${p!.name}” was turned off`,body:out.error.slice(0,200)});
  }
  throw Object.assign(new Error(`${p!.name}: ${out.error}`),{statusCode:502,error:'plugin_failed'});
 }
 if(p!.failure_count)await pool.query('UPDATE plugins SET failure_count=0 WHERE id=$1',[id]);
 if(granted.includes('storage')){
  for(const [k,v] of Object.entries(out.storageSet))await pool.query('INSERT INTO plugin_kv(plugin_id,key,value) VALUES($1,$2,$3) ON CONFLICT(plugin_id,key) DO UPDATE SET value=EXCLUDED.value',[id,k,JSON.stringify(v)]);
  if(out.storageDelete.length)await pool.query('DELETE FROM plugin_kv WHERE plugin_id=$1 AND key=ANY($2::text[])',[id,out.storageDelete]);
 }
 return out.result as T;
}

/** Best-effort notifications to plugins that asked for them; never blocks or fails the caller. */
export function emitHook(event:string,payload:Record<string,unknown>){
 (async()=>{
  const rows=(await pool.query("SELECT id FROM plugins WHERE enabled AND manifest->'hooks' ? $1 AND 'hooks'=ANY(granted_permissions)",[event])).rows;
  for(const r of rows)callPlugin(r.id,`hook:${event}`,[payload],{limits:{deadlineMs:8000}}).catch(()=>{});
 })().catch(()=>{});
}
