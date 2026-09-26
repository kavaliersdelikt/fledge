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
export const imageAllowed=(image:string)=>{const prefixes=(process.env.ALLOWED_IMAGE_PREFIXES||'itzg/minecraft-server:,ghcr.io/lloesche/valheim-server:').split(',').map(s=>s.trim()).filter(Boolean);return prefixes.some(prefix=>image.startsWith(prefix));};
export const hash = (s:string)=>createHash('sha256').update(s).digest('hex');
export const token = ()=>randomBytes(32).toString('base64url');
export const fail = (code:number,message:string):never => {throw Object.assign(new Error(message),{statusCode:code,error:code===403?'forbidden':code===404?'not_found':code===409?'conflict':'bad_request'});};
export const asId=(s:any)=>{if(typeof s!=='string'||!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(s)) fail(400,'Invalid identifier');return s as string;};
export const positive=(value:any,min=1,max=1e9)=>{const n=Number(value);if(!Number.isInteger(n)||n<min||n>max) fail(400,`Must be an integer between ${min} and ${max}`);return n;};
export const txt=(value:any,max=128)=>{if(typeof value!=='string'||!value.trim()||value.length>max) fail(400,`Expected non-empty text (max ${max})`);return value.trim() as string;};
export const page=(q:any)=>({limit:Math.min(100,Math.max(1,Number(q?.limit)||50)),offset:Math.max(0,Number(q?.offset)||0)});
export const safeError=(e:any)=>e?.message?.slice(0,500)||'Operation failed';
export type Actor={id:string,email:string,role:'admin'|'customer',has2fa:boolean,tokenScopes?:string[]};
declare module 'fastify' { interface FastifyRequest {actor?:Actor} }
export function admin(r:FastifyRequest){if(r.actor?.role!=='admin') fail(403,'Provider administrator required');}
export function scope(r:FastifyRequest,s:string){if(r.actor?.tokenScopes&&!r.actor.tokenScopes.includes(s)) fail(403,`Token requires ${s} scope`);}
export async function audit(actor:string|null,action:string,targetType:string,targetId:string,detail:any={}){await pool.query('INSERT INTO audit_events(actor_id,action,target_type,target_id,detail) VALUES($1,$2,$3,$4,$5)',[actor,action,targetType,targetId,JSON.stringify(detail)]);}
export function encrypt(s:string){const k=process.env.ENCRYPTION_KEY;if(!k||!/^([a-f0-9]{64})$/i.test(k)) fail(500,'ENCRYPTION_KEY must be 32-byte hexadecimal');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(k!,'hex'),iv),data=Buffer.concat([cipher.update(s,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
export function decrypt(s:string){const b=Buffer.from(s,'base64'),k=Buffer.from(process.env.ENCRYPTION_KEY!,'hex'),d=createDecipheriv('aes-256-gcm',k,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
export const makeTotp=()=>authenticator.generateSecret();
export const checkTotp=(s:string,code:string)=>/^\d{6}$/.test(code)&&authenticator.check(code,s);
export const passwordHash=(s:string)=>bcrypt.hash(s,12);
export const passwordCheck=(s:string,h:string)=>bcrypt.compare(s,h);
export async function migrate(){const schema=readFileSync(fileURLToPath(new URL('../../db/schema.sql',import.meta.url)),'utf8');await pool.query(schema);}
export async function authenticate(req:FastifyRequest,reply:FastifyReply){
 const url=req.url.split('?')[0];if(url==='/api/health'||['/api/auth/bootstrap','/api/auth/status','/api/auth/login','/api/auth/challenge','/api/auth/recover'].includes(url)||url.startsWith('/api/agent/'))return;
 const cookie=(req.cookies as any)?.fledge_session; const auth=req.headers.authorization;const bearer=auth?.startsWith('Bearer ');
 // An explicit bearer token must never silently inherit a browser cookie's
 // broader permissions (including secret-bearing admin detail responses).
 if(cookie && !bearer && ['POST','PUT','PATCH','DELETE'].includes(req.method)) {const origin=req.headers.origin;if(origin && origin!==WEB_ORIGIN) fail(403,'Invalid Origin');}
 let rows:any[]=[];
 if(bearer){rows=(await pool.query(`SELECT u.id,u.email,u.role,(u.totp_secret IS NOT NULL) AS "has2fa",t.scopes AS "tokenScopes" FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND (t.expires_at IS NULL OR t.expires_at>now()) AND NOT u.disabled`,[hash(auth!.slice(7))])).rows;}
 else if(cookie){rows=(await pool.query(`SELECT u.id,u.email,u.role,(u.totp_secret IS NOT NULL) AS "has2fa" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`,[hash(cookie)])).rows;}
 if(!rows.length) fail(401,'Authentication required'); req.actor=rows[0] as Actor;
 if(req.actor.role==='admin'&&!req.actor.has2fa&&!['/api/auth/me','/api/auth/2fa/setup','/api/auth/2fa/confirm','/api/auth/logout'].includes(url))fail(403,'Enable provider two-factor authentication before operating the panel');
 if(req.actor.tokenScopes){const scopes=req.actor.tokenScopes,p=req.url.split('?')[0];const readable=req.method==='GET'&&scopes.includes('read')&&(p==='/api/auth/me'||p==='/api/customers'||/^\/api\/customers\/[a-f0-9-]+$/.test(p)||p==='/api/servers'||/^\/api\/servers\/[a-f0-9-]+$/.test(p)||p==='/api/jobs'||p==='/api/templates');const provision=req.method==='POST'&&scopes.includes('provision')&&(p==='/api/customers'||p==='/api/servers');const suspend=req.method==='POST'&&scopes.includes('suspend')&&/^\/api\/servers\/[a-f0-9-]+\/actions$/.test(p);if(!readable&&!provision&&!suspend)fail(403,'API token scope does not allow this endpoint');}

}
export async function serverAccess(req:FastifyRequest,id:string,permission?:string){
 const r=await pool.query(`SELECT s.*,n.name AS node_name,n.location,n.status AS node_status,t.image,t.startup,t.internal_ports,t.env,t.editable_variables,t.name AS template_name,
 c.permissions FROM servers s JOIN nodes n ON n.id=s.node_id JOIN templates t ON t.id=s.template_id
 LEFT JOIN collaborators c ON c.server_id=s.id AND c.user_id=$2 WHERE s.id=$1 AND s.deleted_at IS NULL`,[asId(id),req.actor!.id]);
 const s=r.rows[0];if(!s) fail(404,'Server not found');
 if(req.actor?.role==='admin')return s;
 const grants:string[]=s.permissions||[];
 // Detail metadata is available to any collaborator with a real grant, but a
 // specific operation still requires its own grant (or manage). An empty grant
 // must not turn a user into a server viewer.
 const canSeeDetail=grants.some(p=>['view','console','files','backups','manage'].includes(p));
 if(s.owner_id!==req.actor?.id && !(permission ? grants.includes(permission)||grants.includes('manage') : canSeeDetail)) fail(404,'Server not found');
 return s;
}
export const effectivePermissions=(req:FastifyRequest,s:any)=>req.actor?.tokenScopes?['view']:req.actor?.role==='admin'||req.actor?.id===s.owner_id||(s.permissions||[]).includes('manage')?['view','console','files','backups','manage']:(s.permissions||[]).filter((p:string)=>['view','console','files','backups'].includes(p));
export function serverShape(s:any){return {id:s.id,name:s.name,status:s.node_status==='disconnected'?'unreachable':s.observed_status,observedStatus:s.observed_status,desiredStatus:s.desired_status,ownerId:s.owner_id,nodeId:s.node_id,nodeName:s.node_name,location:s.location,templateId:s.template_id,supportsRcon:!!s.image?.startsWith('itzg/minecraft-server:'),memoryMb:s.memory_mb,cpuPercent:s.cpu_percent,diskMb:s.disk_mb,port:s.port,suspended:s.suspended,usage:s.usage,createdAt:s.created_at};}
export function nodeShape(n:any){return {id:n.id,name:n.name,location:n.location,status:n.status,lastSeenAt:n.last_seen_at,draining:n.draining,headroomMb:n.headroom_mb,capacity:{memoryMb:n.memory_mb,cpuPercent:n.cpu_percent,diskMb:n.disk_mb},reserved:{memoryMb:Number(n.reserved_memory||0),cpuPercent:Number(n.reserved_cpu||0),diskMb:Number(n.reserved_disk||0)},usage:n.usage,version:n.version};}
export async function enqueue(nodeId:string,serverId:string|null,kind:string,payload:any={}){return (await pool.query('INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,$3,$4) RETURNING *',[nodeId,serverId,kind,JSON.stringify(payload)])).rows[0];}
