import type {FastifyInstance} from 'fastify';
import {pool,serverAccess,token,hash,hashPassword,verifyPassword,fail,asId,audit} from './core.js';
export function sftpRoutes(app:FastifyInstance){
 app.post('/api/servers/:id/sftp',async(req)=>{const s=await serverAccess(req,(req.params as any).id,'files');if(s.node_status!=='connected')fail(409,'Node is not connected');const secret=token();await pool.query("INSERT INTO sftp_tokens(token_hash,user_id,server_id,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes')",[await hashPassword(secret),req.actor!.id,s.id]);await audit(req.actor!.id,'sftp.issue','server',s.id);return {username:s.id,password:secret,expiresInSeconds:900};});
 app.post('/api/agent/sftp/authorize',async(req)=>{
  const nodeId=asId(req.headers['x-node-id']),bearer=req.headers.authorization||'',b=req.body as any;
  if(!bearer.startsWith('Bearer '))fail(401,'Node credentials required');
  const rows=(await pool.query(`SELECT t.token_hash,s.id,s.disk_mb FROM sftp_tokens t JOIN users u ON u.id=t.user_id JOIN servers s ON s.id=t.server_id JOIN nodes n ON n.id=s.node_id LEFT JOIN collaborators c ON c.server_id=s.id AND c.user_id=u.id WHERE s.id=$1 AND n.id=$2 AND n.credential_hash=$3 AND t.expires_at>now() AND NOT u.disabled AND s.deleted_at IS NULL AND s.observed_status<>'deleting' AND n.deleted_at IS NULL AND (u.role<>'admin' OR u.totp_secret IS NOT NULL) AND (u.role='admin' OR s.owner_id=u.id OR c.permissions && ARRAY['files','manage']::text[])`,[asId(b?.serverId),nodeId,hash(bearer.slice(7))])).rows;
  const providedPassword=String(b?.password||'');
  const s=(await Promise.all(rows.map(async (r:any)=>(await verifyPassword(providedPassword,r.token_hash))?r:null))).find(Boolean);
  if(!s)fail(401,'SFTP access denied');return {serverId:s.id,diskMb:s.disk_mb};
 });
}
