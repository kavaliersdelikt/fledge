import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,encrypt,decrypt,audit} from './core.js';
import {validCidr,ipAllowed} from './cidr.js';

// Panel-managed configuration. Environment variables only seed a section until
// an administrator saves it in the panel; from then on the database wins.
export type StorageSettings={enabled:boolean;endpoint:string;region:string;bucket:string;accessKey:string;forcePathStyle:boolean;secretKey:string};
export type NodeSettings={allowedImagePrefixes:string[];sftpEnabled:boolean;sftpPort:number;diskEnforcement:'auto'|'required'|'off'};
export type AgentUpdateSettings={auto:boolean;source:'github'|'url';baseUrl:string};
export type UpdateSettings={repository:string;githubToken:string};
export type FailoverSettings={enabled:boolean;graceMinutes:number;maxConcurrent:number;maxBackupAgeHours:number;allowWithoutBackup:boolean;sameLocationOnly:boolean;cooldownMinutes:number;protectionEnabled:boolean;protectionIntervalMinutes:number;selfFence:boolean;evictStaleData:boolean;evictedRetentionDays:number;webhookUrl:string};
export type PluginSettings={registryUrl:string;trustedKeys:string[];allowCommunity:boolean};
export type EmailSettings={enabled:boolean;host:string;port:number;security:'none'|'starttls'|'tls';user:string;password:string;from:string};
export type SecuritySettings={adminAllowedCidrs:string[];auditRetentionDays:number};
type Sections={storage:StorageSettings;nodes:NodeSettings;agentUpdates:AgentUpdateSettings;updates:UpdateSettings;failover:FailoverSettings;plugins:PluginSettings;email:EmailSettings;security:SecuritySettings};
type Section=keyof Sections;
const secretFields:Record<Section,string[]>={storage:['secretKey'],nodes:[],agentUpdates:[],updates:['githubToken'],failover:['webhookUrl'],plugins:[],email:['password'],security:[]};
const defaultImages='itzg/minecraft-server:,itzg/minecraft-bedrock-server:,ghcr.io/lloesche/valheim-server:,node:,python:,oven/bun:,golang:,eclipse-temurin:,php:,ruby:,mcr.microsoft.com/dotnet/';
const list=(v:string)=>v.split(',').map(s=>s.trim()).filter(Boolean);

function envDefaults():Sections{
 const e=process.env;
 return {
  storage:{enabled:Boolean(e.S3_BUCKET&&e.S3_ACCESS_KEY&&e.S3_SECRET_KEY),endpoint:e.S3_ENDPOINT||'',region:e.S3_REGION||'us-east-1',bucket:e.S3_BUCKET||'',accessKey:e.S3_ACCESS_KEY||'',forcePathStyle:true,secretKey:e.S3_SECRET_KEY||''},
  nodes:{allowedImagePrefixes:list(e.ALLOWED_IMAGE_PREFIXES||defaultImages),sftpEnabled:true,sftpPort:2022,diskEnforcement:'auto'},
  agentUpdates:{auto:false,source:'github',baseUrl:''},
  updates:{repository:(e.GITHUB_REPOSITORY||'kavaliersdelikt/fledge').trim(),githubToken:e.GITHUB_TOKEN||''},
  failover:{enabled:false,graceMinutes:5,maxConcurrent:2,maxBackupAgeHours:24,allowWithoutBackup:false,sameLocationOnly:false,cooldownMinutes:30,protectionEnabled:false,protectionIntervalMinutes:60,selfFence:false,evictStaleData:true,evictedRetentionDays:7,webhookUrl:''},
  plugins:{registryUrl:e.PLUGIN_REGISTRY_URL??'https://raw.githubusercontent.com/kavaliersdelikt/fledge/main/plugins/registry/index.json',trustedKeys:[],allowCommunity:false},
  email:{enabled:Boolean(e.SMTP_HOST),host:e.SMTP_HOST||'',port:Number(e.SMTP_PORT)||587,security:(['none','starttls','tls'].includes(e.SMTP_SECURITY||'')?e.SMTP_SECURITY:'starttls') as EmailSettings['security'],user:e.SMTP_USER||'',password:e.SMTP_PASSWORD||'',from:e.SMTP_FROM||''},
  security:{adminAllowedCidrs:[],auditRetentionDays:0},
 };
}

let cache:{at:number;value:Sections}|undefined;
export async function settings():Promise<Sections>{
 if(cache&&Date.now()-cache.at<5000)return cache.value;
 const value=envDefaults();
 let rows:any[];
 // Without a reachable database the environment-derived defaults apply, so release checks and
 // other read-only paths keep working (and can be tested without PostgreSQL).
 try{rows=(await pool.query('SELECT key,value,secret FROM settings')).rows;}catch{cache={at:Date.now(),value};return value;}
 for(const row of rows){
  if(!(row.key in value))continue;
  const key=row.key as Section,merged:any={...value[key],...row.value};
  let secrets:Record<string,string>={};
  if(row.secret){try{secrets=JSON.parse(decrypt(row.secret));}catch{secrets={};}}
  for(const f of secretFields[key])if(typeof secrets[f]==='string')merged[f]=secrets[f];
  (value as any)[key]=merged;
 }
 cache={at:Date.now(),value};
 return value;
}
export const invalidateSettings=()=>{cache=undefined;};

const bool=(v:any,name:string)=>{if(typeof v!=='boolean')fail(400,`${name} must be true or false`);return v as boolean;};
const str=(v:any,name:string,max=512)=>{if(typeof v!=='string'||v.length>max)fail(400,`${name} must be text (max ${max})`);return (v as string).trim();};
const url=(v:string,name:string)=>{if(!v)return v;let u:URL;try{u=new URL(v);}catch{return fail(400,`${name} must be a URL`);}if(!['http:','https:'].includes(u.protocol)||u.search||u.hash)fail(400,`${name} must be an http(s) URL without query`);return v.replace(/\/$/,'');};

function validate(section:Section,body:any,current:Sections):any{
 if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Expected an object');
 switch(section){
  case 'storage':{
   const enabled=bool(body.enabled,'enabled');
   const v={enabled,endpoint:url(str(body.endpoint,'Endpoint'),'Endpoint'),region:str(body.region,'Region',64)||'us-east-1',bucket:str(body.bucket,'Bucket',63),accessKey:str(body.accessKey,'Access key',256),forcePathStyle:bool(body.forcePathStyle,'Path-style addressing'),secretKey:body.secretKey===undefined||body.secretKey===null?current.storage.secretKey:str(body.secretKey,'Secret key',256)};
   if(enabled&&(!v.bucket||!v.accessKey||!v.secretKey))fail(400,'Bucket, access key and secret key are required to turn on object storage');
   if(v.bucket&&!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v.bucket))fail(400,'Bucket names use lowercase letters, numbers, dots and hyphens');
   return v;
  }
  case 'nodes':{
   if(!Array.isArray(body.allowedImagePrefixes)||body.allowedImagePrefixes.length>50)fail(400,'Allowed images must be a list');
   const prefixes=[...new Set((body.allowedImagePrefixes as any[]).map(p=>str(p,'Image prefix',200)).filter(Boolean))];
   for(const p of prefixes)if(!/^[a-z0-9][a-z0-9._\/:@-]*$/i.test(p))fail(400,`“${p}” is not an image prefix`);
   const port=Number(body.sftpPort);if(!Number.isInteger(port)||port<1||port>65535)fail(400,'SFTP port must be 1–65535');
   if(!['auto','required','off'].includes(body.diskEnforcement))fail(400,'Unknown disk enforcement mode');
   return {allowedImagePrefixes:prefixes,sftpEnabled:bool(body.sftpEnabled,'SFTP'),sftpPort:port,diskEnforcement:body.diskEnforcement};
  }
  case 'agentUpdates':{
   if(!['github','url'].includes(body.source))fail(400,'Unknown update source');
   const baseUrl=url(str(body.baseUrl||'','Release URL'),'Release URL');
   if(body.source==='url'&&!baseUrl)fail(400,'A release URL is required for a custom source');
   return {auto:bool(body.auto,'Automatic updates'),source:body.source,baseUrl};
  }
  case 'failover':{
   const n=(v:any,name:string,min:number,max:number)=>{const x=Number(v);if(!Number.isInteger(x)||x<min||x>max)fail(400,`${name} must be a whole number from ${min} to ${max}`);return x;};
   const v={enabled:bool(body.enabled,'Automatic failover'),graceMinutes:n(body.graceMinutes,'Wait before failing over (minutes)',2,240),maxConcurrent:n(body.maxConcurrent,'Simultaneous recoveries',1,20),maxBackupAgeHours:n(body.maxBackupAgeHours,'Oldest usable backup (hours)',0,8760),allowWithoutBackup:bool(body.allowWithoutBackup,'Allow recovery without a backup'),sameLocationOnly:bool(body.sameLocationOnly,'Same location only'),cooldownMinutes:n(body.cooldownMinutes,'Cooldown (minutes)',1,10080),protectionEnabled:bool(body.protectionEnabled,'Keep backups fresh'),protectionIntervalMinutes:n(body.protectionIntervalMinutes,'Backup interval (minutes)',5,10080),selfFence:bool(body.selfFence,'Self-fencing'),evictStaleData:bool(body.evictStaleData,'Evict stale data'),evictedRetentionDays:n(body.evictedRetentionDays,'Keep evicted data (days)',0,365),webhookUrl:body.webhookUrl===undefined||body.webhookUrl===null?current.failover.webhookUrl:str(body.webhookUrl,'Webhook URL',1024)};
   if(v.webhookUrl)url(v.webhookUrl,'Webhook URL');
   if(v.enabled&&!current.storage.enabled&&!v.allowWithoutBackup)fail(400,'Failover restores servers from backups, so object storage must be on. Turn it on first, or allow recovery without a backup.');
   return v;
  }
  case 'plugins':{
   const registryUrl=url(str(body.registryUrl??'','Registry URL',500),'Registry URL');
   if(registryUrl&&!registryUrl.startsWith('https://'))fail(400,'The registry URL must use HTTPS');
   if(!Array.isArray(body.trustedKeys)||body.trustedKeys.length>10)fail(400,'Trusted keys must be a list of at most 10 entries');
   const trustedKeys=[...new Set((body.trustedKeys as any[]).map(k=>str(k,'Trusted key',200)).filter(Boolean))];
   for(const k of trustedKeys)if(!/^[A-Za-z0-9+/=]{40,200}$/.test(k))fail(400,'A trusted key must be a base64 Ed25519 public key (SPKI DER)');
   return {registryUrl,trustedKeys,allowCommunity:bool(body.allowCommunity,'Community plugins')};
  }
  case 'email':{
   const enabled=bool(body.enabled,'Email');
   const port=Number(body.port);if(!Number.isInteger(port)||port<1||port>65535)fail(400,'SMTP port must be 1–65535');
   if(!['none','starttls','tls'].includes(body.security))fail(400,'Unknown connection security');
   const from=str(body.from??'','From address',200);
   const v={enabled,host:str(body.host??'','SMTP host',253),port,security:body.security,user:str(body.user??'','SMTP user',254),password:body.password===undefined||body.password===null?current.email.password:str(body.password,'SMTP password',512),from};
   if(enabled&&(!v.host||!from))fail(400,'A host and a From address are required to turn email on');
   if(from&&!/^(?:[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+|[^<>]{1,80}<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>)$/.test(from))fail(400,'From must look like admin@example.com or Fledge <admin@example.com>');
   if(v.host&&!/^[A-Za-z0-9.:\[\]-]+$/.test(v.host))fail(400,'Enter an SMTP host name or address');
   return v;
  }
  case 'security':{
   if(!Array.isArray(body.adminAllowedCidrs)||body.adminAllowedCidrs.length>50)fail(400,'The allow-list must be a list of at most 50 entries');
   const cidrs=[...new Set((body.adminAllowedCidrs as any[]).map(c=>str(c,'Address range',64)).filter(Boolean))];
   for(const c of cidrs)if(!validCidr(c))fail(400,`“${c}” is not an IP address or range (for example 203.0.113.0/24)`);
   const days=Number(body.auditRetentionDays);if(!Number.isInteger(days)||days<0||days>3650)fail(400,'Audit log retention must be 0 (keep everything) to 3650 days');
   return {adminAllowedCidrs:cidrs,auditRetentionDays:days};
  }
  case 'updates':{
   const repository=str(body.repository,'Repository',140);
   if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))fail(400,'Repository must be OWNER/NAME');
   return {repository,githubToken:body.githubToken===undefined||body.githubToken===null?current.updates.githubToken:str(body.githubToken,'GitHub token',512)};
  }
 }
}

export async function saveSection(section:Section,value:any,actor:string){
 const plain:any={...value},secrets:Record<string,string>={};
 for(const f of secretFields[section]){secrets[f]=plain[f]||'';delete plain[f];}
 await pool.query('INSERT INTO settings(key,value,secret,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,secret=EXCLUDED.secret,updated_by=EXCLUDED.updated_by,updated_at=now()',[section,JSON.stringify(plain),secretFields[section].length?encrypt(JSON.stringify(secrets)):null,actor]);
 invalidateSettings();
}

/** Secrets never leave the API; the panel only learns whether one is set. */
export function publicSettings(s:Sections){
 const out:any={};
 for(const key of Object.keys(s) as Section[]){
  const section:any={...s[key]};
  for(const f of secretFields[key]){section[`${f}Set`]=!!section[f];delete section[f];}
  out[key]=section;
 }
 return out;
}

export function settingsRoutes(app:FastifyInstance,hooks:{onSave?:(section:Section)=>void}={}){
 app.get('/api/settings',async(req)=>{admin(req);const s=await settings();const saved=(await pool.query("SELECT key,updated_at FROM settings WHERE key<>'failover_engine'")).rows;return {...publicSettings(s),saved:Object.fromEntries(saved.map(r=>[r.key,r.updated_at]))};});
 app.put('/api/settings/:section',async(req)=>{
  admin(req);const section=(req.params as any).section as Section;
  if(!(section in secretFields))fail(404,'Unknown settings section');
  const current=await settings(),value=validate(section,req.body,current);
  if(section==='security'&&value.adminAllowedCidrs.length&&process.env.ADMIN_IP_ALLOW_DISABLE!=='true'&&!ipAllowed(req.ip,value.adminAllowedCidrs))fail(400,`Your own address (${req.ip}) is not in this list, so saving it would lock you out. Add it first.`);
  await saveSection(section,value,req.actor!.id);
  await audit(req.actor!.id,'settings.update','settings',section,{fields:Object.keys(value).filter(k=>!secretFields[section].includes(k))});
  hooks.onSave?.(section);
  return publicSettings(await settings())[section];
 });
}

export async function allowedImagePrefixes(){return (await settings()).nodes.allowedImagePrefixes;}
export async function imageAllowed(image:string){return (await allowedImagePrefixes()).some(p=>image.startsWith(p));}
