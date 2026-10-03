import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import {pool,WEB_ORIGIN,PORT,authenticate,migrate,safeError,withAdvisoryLock} from './core.js';
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
import {settingsRoutes,settings} from './settings.js';
import {testStorage} from './storage.js';
import {agentUpdateRoutes,sweepAgentUpdates} from './agent-updates.js';
import {failoverRoutes,sweepFailover} from './failover.js';
import {admin,fail} from './core.js';
import {registerPanelCors} from './cors.js';
import {pluginRoutes} from './plugins/routes.js';
import {addonRoutes,sweepAddons,applyAddonResult} from './addons.js';
import {templateRoutes} from './templates.js';
import {portRoutes} from './ports.js';
import {cloneRoutes} from './clone.js';
import {automationRoutes,sweepAutomation} from './automation.js';
import {crashRoutes,sweepCrashes,sweepAlerts} from './crash.js';
import {notificationRoutes,sweepNotifications} from './notifications.js';
import {auditRoutes,sweepAudit} from './audit.js';
import {adminNetworkPolicy} from './netpolicy.js';
import {metricsRoutes,flushMetrics,trimMetrics} from './metrics.js';
import {captureRoutes,openapiRoutes} from './openapi.js';
import {accountRoutes} from './accounts.js';
import {brandingRoutes,sweepBranding} from './branding.js';
import {syncBundled} from './plugins/manager.js';
import {hostConfigured,hostToken} from './plugins/host-client.js';
if(!process.env.DATABASE_URL||!process.env.ENCRYPTION_KEY||!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY))throw Error('DATABASE_URL and a random 32-byte hex ENCRYPTION_KEY are required');
await migrate();
await syncBundled().catch(e=>console.error('Bundled plugin sync failed:',e?.message));
// Creates the shared token the plugin host reads (a no-op when no host is configured).
if(hostConfigured())await hostToken().catch(e=>console.error('Could not prepare the plugin host token:',e?.message));
// TRUST_PROXY: a number of proxy hops (recommended, e.g. 1), a comma-separated list of proxy addresses or ranges, or true
// (trust every hop; only safe when the API is reachable through the proxy alone). Without it req.ip is the socket address.
const trustProxy:any=(v=>!v||v==='false'?false:v==='true'?true:/^\d+$/.test(v)?Number(v):v.split(',').map(x=>x.trim()).filter(Boolean))(process.env.TRUST_PROXY);
const app=Fastify({logger:true,bodyLimit:12*1024*1024,trustProxy});
captureRoutes(app);
// Defensive headers on every API answer; the panel sets its own for pages.
app.addHook('onSend',async(req,reply,payload)=>{reply.header('x-content-type-options','nosniff').header('referrer-policy','no-referrer').header('x-frame-options','DENY').header('content-security-policy',reply.getHeader('content-security-policy')||"default-src 'none'; frame-ancestors 'none'");if(!reply.hasHeader('cache-control')&&req.url.startsWith('/api/')&&!req.url.startsWith('/api/agent/'))reply.header('cache-control','no-store');return payload;});
app.addContentTypeParser('application/octet-stream',(req,payload,done)=>done(null,payload));
await app.register(cookie);await registerPanelCors(app,WEB_ORIGIN);await app.register(multipart,{limits:{fileSize:8*1024*1024}});

await app.register(rateLimit,{max:10000,timeWindow:'1 minute'});
registerOperations(app);
app.addHook('preHandler',async(req,reply)=>{await authenticate(req,reply);await adminNetworkPolicy(req);});
app.setErrorHandler((err,req,reply)=>{req.log.error(err);const sql=(err as any).code;const code=sql==='23505'||sql==='23503'?409:sql==='22P02'?400:(err as any).statusCode||500;reply.code(code).send({error:(err as any).error||(code===500?'internal_error':'request_failed'),message:code>=500&&code!==502&&code!==503&&code!==504?'Internal server error':safeError(err),...((err as any).details&&code<500?{details:(err as any).details}:{})});});
verificationRoutes(app);recoveryRoutes(app);sftpRoutes(app);transferRoutes(app);authRoutes(app);providerRoutes(app);serverRoutes(app);agentRoutes(app);registerLive(app);
registerUpdates(app);settingsRoutes(app);
app.get('/api/storage/status',async()=>({enabled:await backupEnabled()}));agentUpdateRoutes(app);failoverRoutes(app);pluginRoutes(app);addonRoutes(app);templateRoutes(app);portRoutes(app);cloneRoutes(app);automationRoutes(app);crashRoutes(app);notificationRoutes(app);auditRoutes(app);accountRoutes(app);brandingRoutes(app);metricsRoutes(app);openapiRoutes(app);
app.post('/api/settings/storage/test',async(req)=>{admin(req);const b=req.body as any,cur=(await settings()).storage;if(!b||typeof b!=='object')fail(400,'Expected an object');return testStorage({enabled:true,endpoint:String(b.endpoint??cur.endpoint),region:String(b.region||cur.region),bucket:String(b.bucket??cur.bucket),accessKey:String(b.accessKey??cur.accessKey),forcePathStyle:b.forcePathStyle??cur.forcePathStyle,secretKey:b.secretKey?String(b.secretKey):cur.secretKey});});
// Job claims and schedule claims use PostgreSQL row locks; console interests and events are shared in PostgreSQL across API replicas.
let sweeping=false,lastSlow=0;
async function sweep(){if(sweeping)return;sweeping=true;try{
 await pool.query("DELETE FROM sftp_tokens WHERE expires_at<now()");
 await pool.query("DELETE FROM request_limits WHERE expires_at<now()");
 await pool.query("DELETE FROM auth_challenges WHERE expires_at<now()");
 await pool.query("DELETE FROM login_attempts WHERE expires_at<now()-interval '1 hour'");
 await sweepBackupRetention();
 await sweepTransfers();
 await sweepVerification();
 await sweepAgentUpdates();
 await sweepFailover();
 const expired=await pool.query("UPDATE jobs SET state='failed',error='Agent exhausted retry limit',finished_at=now() WHERE state='running' AND lease_until<now() AND attempt>=5 RETURNING id,kind,server_id,payload");for(const j of expired.rows){if(['file.fetch','file.delete','file.rename'].includes(j.kind))await applyAddonResult(pool,j,false,null,'Agent exhausted retry limit').catch(()=>{});if(j.kind==='backup')await pool.query("UPDATE backups SET state='failed',error='Agent exhausted retry limit',completed_at=now() WHERE job_id=$1",[j.id]);if(j.server_id&&['create','reinstall','configure','restore','delete','start','stop','restart','kill'].includes(j.kind))await pool.query("UPDATE servers SET observed_status='failed' WHERE id=$1 AND deleted_at IS NULL AND observed_status<>'deleting'",[j.server_id]);}
 // Each step is isolated so one failing sweep cannot starve the others.
 const step=async(name:string,fn:()=>Promise<unknown>)=>{try{await fn();}catch(e){app.log.error(e,`sweep step ${name} failed`);}};
 await step('metrics',()=>flushMetrics());
 await step('automation',()=>sweepAutomation());
 await step('crashes',()=>withAdvisoryLock(727101,sweepCrashes));
 await step('addons',()=>sweepAddons());
 if(Date.now()-lastSlow>(Number(process.env.SLOW_SWEEP_MS)||60_000)){lastSlow=Date.now();await step('alerts',()=>withAdvisoryLock(727102,sweepAlerts));await step('notifications',()=>sweepNotifications());await step('audit',()=>sweepAudit());await step('branding',()=>sweepBranding());await step('metrics-trim',()=>withAdvisoryLock(727103,trimMetrics));}
 }catch(e){app.log.error(e,'sweeper failed');}finally{sweeping=false;}}
setInterval(sweep,Number(process.env.SWEEP_INTERVAL_MS)||15000).unref();await sweep();
await app.listen({host:process.env.HOST||'0.0.0.0',port:PORT});
