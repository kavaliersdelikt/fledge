import type {FastifyInstance} from 'fastify';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,rm,stat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {pool,serverAccess,fail,asId,hash,audit} from './core.js';
import {backupEnabled,putObjectStream,getObjectStream,deleteObject} from './storage.js';
const maxBytes=1024**3;
// Without object storage, transfers are spooled on the API host. With several
// API replicas this directory must be shared (or object storage turned on).
const spoolDir=process.env.TRANSFER_DIR||'/var/lib/fledge/transfers';
const spoolPath=(id:string)=>join(spoolDir,asId(id));
const virtualPath=(value:unknown)=>{if(typeof value!=='string'||!value.startsWith('/')||value.length>2048||value.includes('\0')||value.includes('\\')||value.split('/').some(p=>p==='..'||p==='.')||value==='/')fail(400,'A file path inside the server directory is required');return value as string;};

async function store(t:any,body:NodeJS.ReadableStream,length:number){
 if(t.store==='s3')return putObjectStream(t.object_key,body,length);
 await mkdir(spoolDir,{recursive:true,mode:0o700});
 const temp=`${spoolPath(t.id)}.part`;let seen=0;
 const counter=new Transform({transform(chunk,_enc,done){seen+=chunk.length;if(seen>length)done(Object.assign(new Error('Body is larger than declared'),{statusCode:400}));else done(null,chunk);}});
 try{await pipeline(body,counter,createWriteStream(temp,{mode:0o600}));}catch(e){await rm(temp,{force:true});throw e;}
 if(seen!==length){await rm(temp,{force:true});fail(400,'Upload ended before the declared size');}
 await rename(temp,spoolPath(t.id));
}
async function load(t:any){
 if(t.store==='s3')return getObjectStream(t.object_key);
 const path=spoolPath(t.id);let size:number;
 try{size=(await stat(path)).size;}catch{return fail(404,'Transfer data is missing');}
 return {body:createReadStream(path),contentLength:size};
}
async function discard(t:any){if(t.store==='s3'){if(await backupEnabled())await deleteObject(t.object_key);}else{await rm(spoolPath(t.id),{force:true});await rm(`${spoolPath(t.id)}.part`,{force:true});}}

export function transferRoutes(app:FastifyInstance){
 app.post('/api/servers/:id/transfers',async(req)=>{
  const s=await serverAccess(req,(req.params as any).id,'files'),b=req.body as any;
  if(s.node_status!=='connected'||s.deleted_at||s.observed_status==='deleting')fail(409,'Server node must be available');
  if(!['upload','download'].includes(b?.direction))fail(400,'Invalid direction');
  const path=virtualPath(b.path),size=b.direction==='upload'?Number(b.size):null;
  if(size!==null&&(!Number.isSafeInteger(size)||size<0||size>maxBytes))fail(413,'File limit is 1 GiB');
  if(size!==null&&size>Number(s.disk_mb)*1048576)fail(413,'The file is larger than this server’s disk allowance');
  const id=crypto.randomUUID(),key=`transfers/${id}`,where=(await backupEnabled())?'s3':'local';
  const t=(await pool.query("INSERT INTO file_transfers(id,server_id,user_id,direction,path,size_bytes,object_key,store) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[id,s.id,req.actor!.id,b.direction,path,size,key,where])).rows[0];
  if(b.direction==='download')await queueTransfer(t,s.node_id);
  await audit(req.actor!.id,`file.${b.direction}`,'server',s.id,{path,transferId:id});
  return {id,state:b.direction==='download'?'queued':'pending'};
 });
 const access=async(req:any)=>{const s=await serverAccess(req,req.params.id,'files');const t=(await pool.query("SELECT t.*,j.state AS job_state,j.error FROM file_transfers t LEFT JOIN jobs j ON j.id=t.job_id WHERE t.id=$1 AND t.server_id=$2 AND t.user_id=$3 AND t.expires_at>now()",[asId(req.params.transferId),s.id,req.actor.id])).rows[0];if(!t)fail(404,'Transfer expired or not found');return {s,t};};
 app.put('/api/servers/:id/transfers/:transferId',{bodyLimit:maxBytes},async(req)=>{
  const {s,t}=await access(req);if(t.direction!=='upload')fail(409,'Not an upload');
  const length=Number(req.headers['content-length']);if(!Number.isSafeInteger(length)||length!==Number(t.size_bytes))fail(400,'File size does not match transfer');
  const claimed=await pool.query("UPDATE file_transfers SET state='uploading' WHERE id=$1 AND state='pending' RETURNING id",[t.id]);if(!claimed.rowCount)fail(409,'Transfer already submitted');
  try{await store(t,req.body as NodeJS.ReadableStream,length);await queueTransfer(t,s.node_id);}catch(e){await pool.query("UPDATE file_transfers SET state='failed' WHERE id=$1",[t.id]);await discard(t).catch(()=>{});throw e;}
  return {id:t.id,state:'queued'};
 });
 app.get('/api/servers/:id/transfers/:transferId',async(req)=>{const {t}=await access(req);return {id:t.id,state:t.job_state||t.state,error:t.error};});
 app.get('/api/servers/:id/transfers/:transferId/content',async(req,reply)=>{
  const {t}=await access(req);if(t.direction!=='download'||t.job_state!=='succeeded')fail(409,'Download is not ready');
  const object=await load(t);reply.type('application/octet-stream').header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(t.path.split('/').pop())}`).header('Cache-Control','no-store');
  if(object.contentLength!==undefined)reply.header('Content-Length',object.contentLength);return object.body;
 });
 const agentTransfer=async(req:any)=>{const node=asId(req.headers['x-node-id']),bearer=req.headers.authorization||'';if(!bearer.startsWith('Bearer '))fail(401,'Node credentials required');const t=(await pool.query("SELECT t.* FROM file_transfers t JOIN jobs j ON j.id=t.job_id JOIN nodes n ON n.id=j.node_id WHERE t.id=$1 AND n.id=$2 AND n.credential_hash=$3 AND n.deleted_at IS NULL AND j.state='running' AND j.attempt=$4 AND j.lease_until>now() AND t.expires_at>now()",[asId(req.params.id),node,hash(bearer.slice(7)),Number(req.query.attempt)])).rows[0];if(!t)fail(409,'Transfer lease is invalid');return t;};
 app.get('/api/agent/transfers/:id',async(req,reply)=>{const t=await agentTransfer(req);if(t.direction!=='upload')fail(409,'Invalid transfer direction');const o=await load(t);reply.type('application/octet-stream');if(o.contentLength!==undefined)reply.header('Content-Length',o.contentLength);return o.body;});
 app.put('/api/agent/transfers/:id',{bodyLimit:maxBytes},async(req)=>{const t=await agentTransfer(req);if(t.direction!=='download')fail(409,'Invalid transfer direction');const size=Number(req.headers['content-length']);if(!Number.isSafeInteger(size)||size<0||size>maxBytes)fail(413,'File limit is 1 GiB');await store(t,req.body as NodeJS.ReadableStream,size);return {ok:true};});
}
async function queueTransfer(t:any,nodeId:string){const c=await pool.connect();try{await c.query('BEGIN');const j=(await c.query("INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,$3,$4) RETURNING id",[nodeId,t.server_id,t.direction==='upload'?'file.import':'file.export',JSON.stringify({transferId:t.id,path:t.path,size:Number(t.size_bytes)})])).rows[0];await c.query("UPDATE file_transfers SET state='queued',job_id=$1 WHERE id=$2",[j.id,t.id]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
// Uploaded data is dropped once the node has imported it; downloads expire after two hours.
export async function sweepTransfers(){
 const rows=(await pool.query("SELECT t.id,t.object_key,t.store FROM file_transfers t LEFT JOIN jobs j ON j.id=t.job_id WHERE t.expires_at<now() OR (t.direction='upload' AND j.state IN ('succeeded','failed')) ORDER BY t.expires_at LIMIT 50")).rows;
 for(const t of rows){try{await discard(t);}catch{continue;}await pool.query('DELETE FROM file_transfers WHERE id=$1',[t.id]);}
}
