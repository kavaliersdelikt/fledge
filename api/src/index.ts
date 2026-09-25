import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import {pool,WEB_ORIGIN,PORT,authenticate,migrate,safeError} from './core.js';
import {authRoutes} from './auth.js';
import {providerRoutes} from './provider.js';
import {serverRoutes} from './servers.js';
import {agentRoutes} from './agent.js';
import {backupEnabled} from './storage.js';
import {verificationRoutes,sweepVerification} from './verification.js';
import {recoveryRoutes} from './recovery.js';
import {sftpRoutes} from './sftp.js';
import {transferRoutes,sweepTransfers} from './transfers.js';
import {registerOperations} from './operations.js';
import {registerLive} from './live.js';
import {sweepBackupRetention} from './backup-maintenance.js';
import {registerUpdates} from './updates.js';
import {registerPanelCors} from './cors.js';
if(!process.env.DATABASE_URL||!process.env.ENCRYPTION_KEY||!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY))throw Error('DATABASE_URL and a random 32-byte hex ENCRYPTION_KEY are required');
await migrate();
const app=Fastify({logger:true,bodyLimit:12*1024*1024,trustProxy:process.env.TRUST_PROXY==='true'});
app.addContentTypeParser('application/octet-stream',(req,payload,done)=>done(null,payload));
await app.register(cookie);await registerPanelCors(app,WEB_ORIGIN);await app.register(multipart,{limits:{fileSize:8*1024*1024}});
registerOperations(app);
app.addHook('preHandler',authenticate);
app.setErrorHandler((err,req,reply)=>{req.log.error(err);const sql=(err as any).code;const code=sql==='23505'||sql==='23503'?409:sql==='22P02'?400:(err as any).statusCode||500;reply.code(code).send({error:(err as any).error||(code===500?'internal_error':'request_failed'),message:code>=500&&code!==502&&code!==503&&code!==504?'Internal server error':safeError(err)});});
verificationRoutes(app);recoveryRoutes(app);sftpRoutes(app);transferRoutes(app);authRoutes(app);providerRoutes(app);serverRoutes(app);agentRoutes(app);registerLive(app);
registerUpdates(app);
// Job claims and schedule claims use PostgreSQL row locks; console interests and events are shared in PostgreSQL across API replicas.
let sweeping=false;
async function sweep(){if(sweeping)return;sweeping=true;try{
 await pool.query("DELETE FROM sftp_tokens WHERE expires_at<now()");
 await pool.query("DELETE FROM request_limits WHERE expires_at<now()");
 await pool.query("DELETE FROM auth_challenges WHERE expires_at<now()");
 await pool.query("DELETE FROM login_attempts WHERE expires_at<now()-interval '1 hour'");
 await pool.query("UPDATE nodes SET status='disconnected' WHERE status='connected' AND last_seen_at<now()-interval '35 seconds'");
 await sweepBackupRetention();
 await sweepTransfers();
 await sweepVerification();
 const expired=await pool.query("UPDATE jobs SET state='failed',error='Agent exhausted retry limit',finished_at=now() WHERE state='running' AND lease_until<now() AND attempt>=5 RETURNING id,kind,server_id");for(const j of expired.rows){if(j.kind==='backup')await pool.query("UPDATE backups SET state='failed',error='Agent exhausted retry limit',completed_at=now() WHERE job_id=$1",[j.id]);if(j.server_id&&['create','reinstall','configure','restore','delete','start','stop','restart','kill'].includes(j.kind))await pool.query("UPDATE servers SET observed_status='failed' WHERE id=$1 AND deleted_at IS NULL AND observed_status<>'deleting'",[j.server_id]);}
 const c=await pool.connect();try{await c.query('BEGIN');const rows=(await c.query("SELECT sc.*,s.node_id FROM schedules sc JOIN servers s ON s.id=sc.server_id WHERE sc.enabled AND sc.next_run_at<=now() AND s.deleted_at IS NULL FOR UPDATE OF sc SKIP LOCKED LIMIT 50")).rows;for(const sc of rows){await c.query("UPDATE schedules SET next_run_at=now()+((interval_minutes::text||' minutes')::interval) WHERE id=$1",[sc.id]);if(sc.kind==='backup'&&!backupEnabled())continue;if(sc.kind==='backup'){const b=(await c.query('INSERT INTO backups(server_id,object_key) VALUES($1,$2) RETURNING id',[sc.server_id,`servers/${sc.server_id}/backups/${crypto.randomUUID()}.tar.gz`])).rows[0];const j=(await c.query("INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,'backup',$3) RETURNING id",[sc.node_id,sc.server_id,JSON.stringify({backupId:b.id})])).rows[0];await c.query('UPDATE backups SET job_id=$1 WHERE id=$2',[j.id,b.id]);}else await c.query("INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,'command',$3)",[sc.node_id,sc.server_id,JSON.stringify({command:sc.command})]);}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }catch(e){app.log.error(e,'sweeper failed');}finally{sweeping=false;}}
setInterval(sweep,15000).unref();await sweep();
await app.listen({host:process.env.HOST||'0.0.0.0',port:PORT});

