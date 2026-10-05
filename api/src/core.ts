import {ALL_PERMISSIONS,PRESETS,routePermission,type Permission} from './permissions.js';
import {suspensionAllows} from './suspension-policy.js';
import pg from 'pg';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authenticator } from 'otplib';
import bcrypt from 'bcryptjs';
import type { FastifyRequest, FastifyReply } from 'fastify';

export const pool = new pg.Pool({connectionString:process.env.DATABASE_URL, max:20});
export const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';
export const PORT = Number(process.env.PORT || 4000);
export const SESSION_DAYS = 7;
// Plain string checks instead of a regular expression, so there is nothing to backtrack on.
export function looksLikeEmail(v:unknown):v is string{
 if(typeof v!=='string'||v.length<5||v.length>254||/[\s<>]/.test(v))return false;
 const at=v.indexOf('@');
 if(at<1||at!==v.lastIndexOf('@'))return false;
 const domain=v.slice(at+1),dot=domain.lastIndexOf('.');
 return dot>0&&dot<domain.length-1;
}
/** `admin@example.com` or `Name <admin@example.com>`. */
export function looksLikeMailbox(v:string){
 if(!v.includes('<'))return looksLikeEmail(v);
 const open=v.indexOf('<');
 return v.endsWith('>')&&open>=1&&open<=81&&!v.slice(0,open).includes('>')&&looksLikeEmail(v.slice(open+1,-1));
}
export const hash = (s:string)=>createHash('sha256').update(s).digest('hex');
export const hashPassword = async (password:string)=>bcrypt.hash(password, 12);
export const verifyPassword = async (password:string, hashed:string)=>bcrypt.compare(password, hashed);
export const token = ()=>randomBytes(32).toString('base64url');
export const fail = (code:number,message:string):never => {throw Object.assign(new Error(message),{statusCode:code,error:code===403?'forbidden':code===404?'not_found':code===409?'conflict':'bad_request'});};
export const asId=(s:any)=>{if(typeof s!=='string'||!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(s)) fail(400,'Invalid identifier');return s as string;};
export const positive=(value:any,min=1,max=1e9)=>{const n=Number(value);if(!Number.isInteger(n)||n<min||n>max) fail(400,`Must be an integer between ${min} and ${max}`);return n;};
export const txt=(value:any,max=128)=>{if(typeof value!=='string'||!value.trim()||value.length>max) fail(400,`Expected non-empty text (max ${max})`);return value.trim() as string;};
export const page=(q:any)=>({limit:Math.min(100,Math.max(1,Number(q?.limit)||50)),offset:Math.max(0,Number(q?.offset)||0)});
export const safeError=(e:any)=>e?.message?.slice(0,500)||'Operation failed';
export type Actor={id:string,email:string,role:'admin'|'customer',has2fa:boolean,isSuper?:boolean,permissions?:Permission[],status?:string,suspended?:boolean,tokenScopes?:string[]};
declare module 'fastify' { interface FastifyRequest {actor?:Actor} }
export function can(r:FastifyRequest,p:Permission){if(r.actor?.role!=='admin'||(p==='team.manage'?!r.actor.isSuper:!r.actor.isSuper&&!r.actor.permissions?.includes(p)))fail(403,`Permission required: ${p}`);}
export function admin(r:FastifyRequest){const p=routePermission(r.method,r.url,(r.body as any)?.action);if(!p)fail(403,'No administrator grant declared for this route');can(r,p!);}
export async function stepUp(r:FastifyRequest){
 if(r.actor?.tokenScopes)fail(403,'Browser session required');
 const cookie=(r.cookies as any)?.fledge_session;
 const row=(await pool.query('SELECT s.stepped_up_at,u.totp_secret FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>now()',[hash(cookie||''),r.actor!.id])).rows[0];
 if(!row)fail(401,'Authentication required');
 if(row.stepped_up_at&&Date.now()-new Date(row.stepped_up_at).getTime()<600000)return;
 const {mfaLocked,mfaFailed}=await import('./auth.js');
 if(await mfaLocked(r.actor!.id))fail(429,'Too many verification attempts');
 if(!row.totp_secret||!checkTotp(decrypt(row.totp_secret),String((r.body as any)?.totp||''))){await mfaFailed(r.actor!.id);throw Object.assign(new Error('Confirm with a fresh authenticator code'),{statusCode:403,error:'step_up_required'});}
 await pool.query('UPDATE sessions SET stepped_up_at=now() WHERE token_hash=$1',[hash(cookie)]);
}

export function scope(r:FastifyRequest,s:string){if(r.actor?.tokenScopes&&!r.actor.tokenScopes.includes(s)) fail(403,`Token requires ${s} scope`);}
export async function audit(actor:string|null,action:string,targetType:string,targetId:string,detail:any={}){await pool.query('INSERT INTO audit_events(actor_id,action,target_type,target_id,detail) VALUES($1,$2,$3,$4,$5)',[actor,action,targetType,targetId,JSON.stringify(detail)]);}
export function encrypt(s:string){const k=process.env.ENCRYPTION_KEY;if(!k||!/^([a-f0-9]{64})$/i.test(k)) fail(500,'ENCRYPTION_KEY must be 32-byte hexadecimal');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(k!,'hex'),iv),data=Buffer.concat([cipher.update(s,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
export function decrypt(s:string){const b=Buffer.from(s,'base64'),k=Buffer.from(process.env.ENCRYPTION_KEY!,'hex'),d=createDecipheriv('aes-256-gcm',k,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
export const makeTotp=()=>authenticator.generateSecret();
export const checkTotp=(s:string,code:string)=>/^\d{6}$/.test(code)&&authenticator.clone({window:1}).check(code,s);
export const passwordHash=(s:string)=>bcrypt.hash(s,12);
export const passwordCheck=(s:string,h:string)=>bcrypt.compare(s,h);
export async function migrate(){const schema=readFileSync(fileURLToPath(new URL('../../db/schema.sql',import.meta.url)),'utf8');await pool.query(schema);}
export async function authenticate(req:FastifyRequest,reply:FastifyReply){
 const url=req.url.split('?')[0];if(url==='/api/health'||url==='/api/support/public'||url==='/api/support/abuse/config'||url==='/api/support/abuse'||url==='/api/support/inbound'||(req.method==='GET'&&(url==='/api/branding'||/^\/api\/branding\/assets\/(?:mark|wordmark|favicon|login)$/.test(url)))||['/api/auth/bootstrap','/api/auth/status','/api/auth/login','/api/auth/challenge','/api/auth/recover','/api/auth/forgot','/api/auth/token/accept','/api/auth/passkey/options','/api/auth/passkey/verify','/api/signup/config','/api/auth/register','/api/auth/verify','/api/auth/verify/resend','/api/auth/email/confirm','/api/store/public'].includes(url)||url.startsWith('/api/agent/')||url.startsWith('/api/billing/webhooks/'))return;
 const cookie=(req.cookies as any)?.fledge_session; const auth=req.headers.authorization;const bearer=auth?.startsWith('Bearer ');
 // An explicit bearer token must never silently inherit a browser cookie's
 // broader permissions (including secret-bearing admin detail responses).
 if(cookie && !bearer && ['POST','PUT','PATCH','DELETE'].includes(req.method)) {const origin=req.headers.origin;if(origin && origin!==WEB_ORIGIN) fail(403,'Invalid Origin');}
 let rows:any[]=[];
 if(bearer){rows=(await pool.query(`SELECT u.id,u.email,u.role,u.status,u.is_super AS "isSuper",u.admin_permissions AS permissions,(u.totp_secret IS NOT NULL) AS "has2fa",t.scopes AS "tokenScopes" FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND (t.expires_at IS NULL OR t.expires_at>now()) AND NOT u.disabled AND u.status IN ('active','deletion_pending','suspended')`,[hash(auth!.slice(7))])).rows;}
 else if(cookie){rows=(await pool.query(`SELECT u.id,u.email,u.role,u.status,u.is_super AS "isSuper",u.admin_permissions AS permissions,(u.totp_secret IS NOT NULL) AS "has2fa" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled AND u.status IN ('active','deletion_pending','suspended')`,[hash(cookie)])).rows;}
 if(!rows.length) fail(401,'Authentication required'); req.actor=rows[0] as Actor;if(cookie&&!bearer)pool.query("UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND last_seen_at<now()-interval '1 minute'",[hash(cookie)]).catch(()=>{});
 req.actor.suspended=req.actor.status==='suspended'||!!(await pool.query('SELECT 1 FROM account_suspensions WHERE user_id=$1 AND lifted_at IS NULL',[req.actor.id])).rowCount;
 if(req.actor.suspended){
  const hold=(await pool.query('SELECT s.reference,s.allow_account_deletion,s.allow_backup_download,(SELECT id FROM support_tickets t WHERE t.suspension_id=s.id ORDER BY created_at DESC LIMIT 1) AS ticket_id FROM account_suspensions s WHERE s.user_id=$1 AND s.lifted_at IS NULL',[req.actor.id])).rows[0];
  if(bearer||!suspensionAllows(req.method,url,{allowDeletion:hold?.allow_account_deletion,allowBackupDownload:hold?.allow_backup_download,ticketId:hold?.ticket_id}))throw Object.assign(new Error('Your account is suspended'),{statusCode:403,error:'account_suspended',details:{reference:hold?.reference}});
 }
 if(req.actor.role==='admin'){req.actor.permissions=req.actor.isSuper?ALL_PERMISSIONS:req.actor.permissions??PRESETS.Administrator;}
 if(req.actor.role==='admin'&&!req.actor.has2fa&&!['/api/auth/me','/api/auth/2fa/setup','/api/auth/2fa/confirm','/api/auth/logout'].includes(url))fail(403,'Enable provider two-factor authentication before operating the panel');
 if(req.actor.role==='admin'&&!url.startsWith('/api/auth/')&&!url.startsWith('/api/account/')&&!['/api/features','/api/permissions','/api/limits/me','/api/team/transfer/confirm','/api/notifications','/api/notifications/summary','/api/notifications/read'].includes(url)&&!url.startsWith('/api/store')){
  const p=routePermission(req.method,url,(req.body as any)?.action);if(!p)fail(403,'No administrator grant declared for this route');can(req,p!);
  if(req.method==='PATCH'&&/^\/api\/customers\/[^/]+$/.test(url)&&['password','disabled'].some(k=>(req.body as any)?.[k]!==undefined)){can(req,'customers.security');await stepUp(req);}
  if(['customers.security','customers.delete','billing.refund'].includes(p!)||p==='team.manage'&&req.method!=='GET'||url==='/api/settings/security'&&req.method==='PUT')await stepUp(req);
 }
 if(req.actor.tokenScopes){const scopes=req.actor.tokenScopes,p=req.url.split('?')[0];const readable=req.method==='GET'&&scopes.includes('read')&&(p==='/api/auth/me'||p==='/api/customers'||/^\/api\/customers\/[a-f0-9-]+$/.test(p)||p==='/api/servers'||/^\/api\/servers\/[a-f0-9-]+$/.test(p)||p==='/api/jobs'||p==='/api/templates');const provision=req.method==='POST'&&scopes.includes('provision')&&(p==='/api/customers'||p==='/api/servers');const suspend=req.method==='POST'&&scopes.includes('suspend')&&/^\/api\/servers\/[a-f0-9-]+\/actions$/.test(p);if(!readable&&!provision&&!suspend)fail(403,'API token scope does not allow this endpoint');}

}
export async function serverAccess(req:FastifyRequest,id:string,permission?:string){
 const r=await pool.query(`SELECT s.*,n.name AS node_name,n.location,n.status AS node_status,n.version AS node_version,t.image,t.startup,t.internal_ports,t.env,t.editable_variables,t.addons AS template_addons,t.variables AS template_variables,t.version AS template_current_version,t.name AS template_name,
 c.permissions FROM servers s JOIN nodes n ON n.id=s.node_id JOIN templates t ON t.id=s.template_id
 LEFT JOIN collaborators c ON c.server_id=s.id AND c.user_id=$2 WHERE s.id=$1 AND s.deleted_at IS NULL`,[asId(id),req.actor!.id]);
 const s=r.rows[0];if(!s) fail(404,'Server not found');
 if(s.runtime==='vm'&&/^\/api\/servers\/[^/]+\/(?:files|sftp|console|startup|settings|addons)(?:\/|$)/.test(req.url.split('?')[0]))fail(409,'This operation is available only for containers; use the virtual machine controls');
 if(req.actor?.role==='admin'){const p=routePermission(req.method,req.url,(req.body as any)?.action);if(!p)fail(403,'No administrator grant declared');can(req,p!);return s;}
 const grants:string[]=s.permissions||[];
 // Detail metadata is available to any collaborator with a real grant, but a
 // specific operation still requires its own grant (or manage). An empty grant
 // must not turn a user into a server viewer.
 const canSeeDetail=grants.some(p=>['view','console','files','backups','manage','vm.configure','vm.network','vm.media','vm.snapshots'].includes(p));
 if(s.owner_id!==req.actor?.id && !(permission ? grants.includes(permission)||grants.includes('manage') : canSeeDetail)) fail(404,'Server not found');
 return s;
}
export function effectivePermissions(req:FastifyRequest,s:any){
 const base=['view','console','files','backups','manage'];
 const vm=s.runtime==='vm'?['vm.configure','vm.network','vm.media','vm.snapshots']:[];
 const available=[...base,...vm];
 if(req.actor?.tokenScopes)return ['view'];
 if(req.actor?.role==='admin'){const actor=req.actor;return available.filter(p=>actor.isSuper||actor.permissions?.includes(('servers.'+(p==='view'?'view':p)) as Permission));}
 if(req.actor?.id===s.owner_id||(s.permissions||[]).includes('manage'))return available;
 return (s.permissions||[]).filter((p:string)=>available.includes(p));
}
export function serverShape(s:any){return {id:s.id,name:s.name,runtime:s.runtime||'container',pendingDeleteAt:s.pending_delete_at||null,subscriptionId:s.subscription_id||null,suspendedReason:s.suspended_reason||null,createdVia:s.created_via||'admin',status:s.node_status==='disconnected'?'unreachable':s.observed_status,observedStatus:s.observed_status,desiredStatus:s.desired_status,ownerId:s.owner_id,nodeId:s.node_id,nodeName:s.node_name,location:s.location,templateId:s.template_id,supportsRcon:!!s.image?.startsWith('itzg/minecraft-server:'),memoryMb:s.memory_mb,cpuPercent:s.cpu_percent,diskMb:s.disk_mb,port:s.port,suspended:s.suspended,usage:s.usage,createdAt:s.created_at};}
export function nodeShape(n:any){return {id:n.id,name:n.name,location:n.location,status:n.status,lastSeenAt:n.last_seen_at,draining:n.draining,headroomMb:n.headroom_mb,capacity:{memoryMb:n.memory_mb,cpuPercent:n.cpu_percent,diskMb:n.disk_mb},reserved:{memoryMb:Number(n.reserved_memory||0),cpuPercent:Number(n.reserved_cpu||0),diskMb:Number(n.reserved_disk||0)},usage:n.usage,version:n.version,agent:n.agent||{},publicHost:n.public_host||null};}
// Recreating a container starts the server; a server that should stay stopped gets a follow-up stop so a port or
// template change never boots a stopped (or suspended) server.
export async function queueRecreate(db:{query:(q:string,p?:any[])=>Promise<any>},row:{node_id:string;id:string;desired_status?:string;suspended?:boolean}){
 const job=(await db.query("INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,'configure',$3) RETURNING id,state",[row.node_id,row.id,JSON.stringify({recreate:true})])).rows[0] as {id:string;state:string};
 if(row.suspended||(row.desired_status&&row.desired_status!=='running'))await db.query("INSERT INTO jobs(node_id,server_id,kind,payload,created_at) VALUES($1,$2,'stop','{}',clock_timestamp())",[row.node_id,row.id]);
 return job;
}
// Runs fn only if no other API replica holds the same advisory lock; returns false when someone else does.
export async function withAdvisoryLock(key:number,fn:()=>Promise<void>){
 const c=await pool.connect();
 try{
  if(!(await c.query('SELECT pg_try_advisory_lock($1) AS ok',[key])).rows[0].ok)return false;
  try{await fn();}finally{await c.query('SELECT pg_advisory_unlock($1)',[key]).catch(()=>{});}
  return true;
 }finally{c.release();}
}
export async function enqueue(nodeId:string,serverId:string|null,kind:string,payload:any={}){return (await pool.query('INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,$3,$4) RETURNING *',[nodeId,serverId,kind,JSON.stringify(payload)])).rows[0];}
