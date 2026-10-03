import {settings} from '../settings.js';
import {safeGet,GuardError} from '../netguard.js';
import {newer,parse} from '../updates.js';
import {permissionProblem} from './manifest.js';
import {MAX_PACKAGE_BYTES,readPackage,sha256,verifySignature,type PluginPackage} from './package.js';

// The plugin registry is a signed JSON index (default: plugins/registry/index.json in the
// Fledge repository). Entries point at .fledgeplugin files; the checksum in the index is what
// the download must match and, with the signature, what makes a plugin "verified".

export type RegistryEntry={id:string;name:string;version:string;description:string;author:string;license?:string;homepage?:string;icon?:string;permissions:string[];downloadUrl:string;sha256:string;size?:number;signature?:string;minPanelVersion?:string;verified:boolean};
export type Registry={entries:RegistryEntry[];error:string|null;fetchedAt:string|null;url:string};
// Built-in trust anchors for the official registry. Keys can also be added in the panel
// (Settings → Plugins). Empty until the project publishes its signing key.
export const OFFICIAL_KEYS:string[]=[];
const unsafeLocal=()=>process.env.FLEDGE_TEST_ALLOW_LOCAL_FETCH==='1'?{allowPrivate:true,allowHttp:true}:{};

let cache:{at:number;url:string;value:Registry}|undefined;
export const clearRegistryCache=()=>{cache=undefined;};

export async function trustedKeys(){return [...OFFICIAL_KEYS,...(await settings()).plugins.trustedKeys];}

export async function fetchRegistry(force=false):Promise<Registry>{
 const cfg=(await settings()).plugins,url=cfg.registryUrl;
 if(!url)return {entries:[],error:null,fetchedAt:null,url};
 if(!force&&cache&&cache.url===url&&Date.now()-cache.at<10*60_000)return cache.value;
 let value:Registry;
 try{
  const res=await safeGet(url,{maxBytes:512*1024,timeoutMs:8000,...unsafeLocal()});
  if(res.status===404)throw new GuardError('The registry index was not found (404). No community plugins are published there yet.');
  if(res.status!==200)throw new GuardError(`The registry answered ${res.status}`);
  const doc=JSON.parse(res.body.toString('utf8'));
  if(doc?.schema!==1||!Array.isArray(doc.plugins))throw new GuardError('The registry index has an unsupported format');
  const keys=await trustedKeys(),entries:RegistryEntry[]=[];
  for(const e of doc.plugins.slice(0,200)){
   if(!e||typeof e.id!=='string'||typeof e.version!=='string'||!parse(e.version)||typeof e.name!=='string'||typeof e.downloadUrl!=='string'||!(/^https:\/\//.test(e.downloadUrl)||(unsafeLocal().allowHttp&&/^http:\/\//.test(e.downloadUrl)))||!/^[a-f0-9]{64}$/.test(String(e.sha256)))continue;
   if(!/^[a-z0-9][a-z0-9-]{1,48}$/.test(e.id))continue;
   const permissions=Array.isArray(e.permissions)?e.permissions.filter((p:unknown)=>!permissionProblem(p)).slice(0,20):[];
   entries.push({id:e.id,name:String(e.name).slice(0,60),version:e.version,description:String(e.description||'').slice(0,400),author:String(e.author||'').slice(0,80),license:e.license?String(e.license).slice(0,60):undefined,homepage:typeof e.homepage==='string'&&e.homepage.startsWith('https://')?e.homepage.slice(0,300):undefined,icon:typeof e.icon==='string'&&e.icon.startsWith('data:image/')&&e.icon.length<100_000?e.icon:undefined,permissions,downloadUrl:e.downloadUrl,sha256:e.sha256,size:Number.isFinite(e.size)?e.size:undefined,signature:typeof e.signature==='string'?e.signature:undefined,minPanelVersion:typeof e.minPanelVersion==='string'?e.minPanelVersion:undefined,verified:verifySignature(keys,e.id,e.version,e.sha256,e.signature)});
  }
  value={entries,error:null,fetchedAt:new Date().toISOString(),url};
 }catch(e:any){
  value={entries:[],error:e instanceof GuardError?e.message:e instanceof SyntaxError?'The registry index is not valid JSON':`The registry could not be reached (${e?.message||'error'})`,fetchedAt:new Date().toISOString(),url};
 }
 cache={at:Date.now(),url,value};
 return value;
}

export async function downloadRegistryPackage(entry:RegistryEntry):Promise<{pkg:PluginPackage;verified:boolean}>{
 let res;
 try{res=await safeGet(entry.downloadUrl,{maxBytes:MAX_PACKAGE_BYTES,timeoutMs:20_000,...unsafeLocal()});}
 catch(e:any){throw Object.assign(new Error(e instanceof GuardError?e.message:'The package could not be downloaded'),{statusCode:502});}
 if(res.status!==200)throw Object.assign(new Error(`The download answered ${res.status}`),{statusCode:502});
 if(sha256(res.body)!==entry.sha256)throw Object.assign(new Error('The downloaded package does not match the checksum in the registry. It was not installed.'),{statusCode:422});
 const pkg=readPackage(res.body);
 if(pkg.manifest.id!==entry.id||pkg.manifest.version!==entry.version)throw Object.assign(new Error('The package does not match the registry entry (id or version differ). It was not installed.'),{statusCode:422});
 return {pkg,verified:verifySignature(await trustedKeys(),entry.id,entry.version,entry.sha256,entry.signature)};
}
export const registryNewer=(entry:{version:string},installed:string)=>newer(entry.version,installed);
