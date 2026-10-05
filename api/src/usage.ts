import type {FastifyInstance,FastifyRequest} from 'fastify';
import {createHash,createPublicKey,randomBytes} from 'node:crypto';
import {pool,fail,encrypt,decrypt,audit,withAdvisoryLock} from './core.js';
import {safeRequest} from './netguard.js';
import {sealUsageReport,type UsageReport} from '../../shared/usage-envelope.js';
import {USAGE_DEFAULT_CLIENT_ID,USAGE_DEFAULT_PUBLIC_KEY,USAGE_DEFAULT_REPOSITORY} from './usage-defaults.js';
const notice=1;
function validPublicKey(value:string){try{const decoded=Buffer.from(value,'base64').toString();const k=createPublicKey(decoded);return k.asymmetricKeyType==='rsa'&&(k.asymmetricKeyDetails?.modulusLength||0)>=2048?decoded:'';}catch{return ''}}
async function config(){
 const stored=(await pool.query("SELECT value FROM settings WHERE key='usage_reporting_config'")).rows[0]?.value||{};
 const repository=String(stored.repository||process.env.USAGE_INTAKE_REPOSITORY||USAGE_DEFAULT_REPOSITORY),clientId=String(stored.clientId||process.env.USAGE_GITHUB_CLIENT_ID||USAGE_DEFAULT_CLIENT_ID),publicKeyBase64=String(stored.publicKeyBase64||process.env.USAGE_INTAKE_PUBLIC_KEY||USAGE_DEFAULT_PUBLIC_KEY);
 const publicKey=validPublicKey(publicKeyBase64);
 const configured=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)&&/^[A-Za-z0-9_.]{10,128}$/.test(clientId)&&!!publicKey;
 return {repository,clientId,publicKey,publicKeyBase64,configured,policyHash:createHash('sha256').update(JSON.stringify({repository,clientId,publicKey,notice})).digest('hex')};
}
function owner(req:FastifyRequest){if(req.actor?.role!=='admin'||!req.actor.isSuper||req.actor.tokenScopes)fail(403,'A super-administrator browser session is required');}
async function github(url:string,body:Record<string,unknown>,token?:string){
 const oauth=url.startsWith('https://github.com/login/');if(!oauth&&!url.startsWith('https://api.github.com/repos/'))throw Error('Invalid GitHub destination');
 const response=await safeRequest(url,{method:'POST',body:oauth?new URLSearchParams(body as Record<string,string>).toString():JSON.stringify(body),headers:{accept:'application/json','content-type':oauth?'application/x-www-form-urlencoded':'application/json','user-agent':'Fledge-opt-in-usage',...(token?{authorization:'Bearer '+token}:{})},maxBytes:16384,timeoutMs:10000,redirects:0});
 if(response.status<200||response.status>=300)throw Error('GitHub request failed');return JSON.parse(response.body.toString());
}
const readSecret=(s:any)=>s.secret?JSON.parse(decrypt(s.secret)):{};
async function shape(s:any){const c=await config(),secret=readSecret(s);return {configured:c.configured,repository:c.repository,clientId:c.clientId,publicKeyBase64:c.publicKeyBase64,noticeVersion:notice,consent:s.consent,reviewed:!!s.consent_at,needsReview:!!s.consent&&s.policy_hash!==c.policyHash,connected:!!secret.access_token,lastReportDay:s.last_report_day,lastError:s.last_error,withdrawalPending:s.withdrawal_pending};}
let activityAt=0;
export function observeUsageActivity(req:FastifyRequest){if(!req.actor||req.url.startsWith('/api/usage')||Date.now()-activityAt<300000)return;activityAt=Date.now();void pool.query('UPDATE usage_reporting SET last_activity_at=now() WHERE singleton AND consent').catch(()=>{});}
export function usageRoutes(app:FastifyInstance){
 app.get('/api/usage',async req=>{owner(req);return shape((await pool.query('SELECT * FROM usage_reporting WHERE singleton')).rows[0]);});
 app.put('/api/usage/config',async req=>{owner(req);const b=req.body as any,repository=typeof b?.repository==='string'?b.repository.trim():'',clientId=typeof b?.clientId==='string'?b.clientId.trim():'',publicKeyBase64=typeof b?.publicKeyBase64==='string'?b.publicKeyBase64.trim():'';if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)||!/^[A-Za-z0-9_.]{10,128}$/.test(clientId)||!validPublicKey(publicKeyBase64))fail(400,'Enter a valid public GitHub repository, App Client ID and RSA public key (base64 PEM)');await pool.query("INSERT INTO settings(key,value,updated_by) VALUES('usage_reporting_config',$1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()",[JSON.stringify({repository,clientId,publicKeyBase64}),req.actor!.id]);await audit(req.actor!.id,'usage.configuration','settings','usage-reporting',{repository});return shape((await pool.query('SELECT * FROM usage_reporting WHERE singleton')).rows[0]);});
 app.post('/api/usage/consent',async req=>{owner(req);const b=req.body as any;if(typeof b?.consent!=='boolean'||b.noticeVersion!==notice)fail(400,'Review the current notice and choose whether to report');const c=await config();if(b.consent&&!c.configured)fail(409,'Configure the maintainer GitHub intake in this panel');if(b.consent&&(await pool.query('SELECT 1 FROM usage_reporting WHERE singleton AND withdrawal_pending')).rowCount)fail(409,'Wait for the removal request to finish before opting in again');
  if(b.consent)await pool.query('UPDATE usage_reporting SET consent=true,consent_at=now(),policy_hash=$1,installation_id=CASE WHEN policy_hash=$1 THEN coalesce(installation_id,$2) ELSE $2 END,secret=CASE WHEN policy_hash=$1 THEN secret ELSE NULL END,last_activity_at=now(),next_attempt_at=now(),updated_at=now() WHERE singleton',[c.policyHash,randomBytes(32).toString('base64url')]);
  else await pool.query("UPDATE usage_reporting SET consent=false,consent_at=now(),installation_id=CASE WHEN secret IS NULL THEN NULL ELSE installation_id END,withdrawal_pending=(secret IS NOT NULL AND installation_id IS NOT NULL),withdrawal_until=now()+interval '7 days',next_attempt_at=now(),updated_at=now() WHERE singleton");
  await audit(req.actor!.id,b.consent?'usage.consent':'usage.withdraw','settings','usage-reporting',{noticeVersion:notice});return {ok:true};
 });
 app.post('/api/usage/connect',async req=>{owner(req);const c=await config(),state=(await pool.query('SELECT * FROM usage_reporting WHERE singleton')).rows[0];if(!c.configured||!state.consent||state.policy_hash!==c.policyHash)fail(409,'Review and accept the reporting notice first');
  const result=await github('https://github.com/login/device/code',{client_id:c.clientId});
  if(typeof result.device_code!=='string'||typeof result.user_code!=='string'||result.verification_uri!=='https://github.com/login/device'||!Number.isInteger(result.expires_in)||result.expires_in<1||result.expires_in>1800)fail(502,'GitHub returned an invalid authorization challenge');
  const interval=Math.max(5,Math.min(60,Number(result.interval)||5));await pool.query('UPDATE usage_reporting SET secret=$1,updated_at=now() WHERE singleton AND consent AND policy_hash=$2',[encrypt(JSON.stringify({device_code:result.device_code,expires:Date.now()+result.expires_in*1000,pollAt:Date.now()+interval*1000,interval})),c.policyHash]);
  return {userCode:result.user_code,verificationUrl:result.verification_uri,expiresIn:result.expires_in,interval};
 });
 app.post('/api/usage/connect/poll',async req=>{owner(req);const c=await pool.connect();try{await c.query('BEGIN');const state=(await c.query('SELECT * FROM usage_reporting WHERE singleton FOR UPDATE')).rows[0],secret=readSecret(state),cfg=await config();if(!state.consent||state.policy_hash!==cfg.policyHash)fail(409,'Reporting consent is no longer valid');if(secret.access_token){await c.query('COMMIT');return {connected:true}};if(!secret.device_code||secret.expires<Date.now())fail(409,'GitHub authorization expired; connect again');if(secret.pollAt>Date.now()){await c.query('COMMIT');return {connected:false,interval:secret.interval}};
  const result=await github('https://github.com/login/oauth/access_token',{client_id:cfg.clientId,device_code:secret.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'});
  if(result.error&& !['authorization_pending','slow_down'].includes(result.error))fail(409,'GitHub authorization was declined or expired');
  if(result.access_token){if(typeof result.access_token!=='string'||result.token_type!=='bearer')fail(502,'GitHub returned an invalid authorization');await c.query('UPDATE usage_reporting SET secret=$1,next_attempt_at=now(),last_error=NULL WHERE singleton',[encrypt(JSON.stringify({access_token:result.access_token,refresh_token:result.refresh_token,expires:result.expires_in?Date.now()+result.expires_in*1000:null}))]);}else{secret.interval=Math.min(60,secret.interval+(result.error==='slow_down'?5:0));secret.pollAt=Date.now()+secret.interval*1000;await c.query('UPDATE usage_reporting SET secret=$1 WHERE singleton',[encrypt(JSON.stringify(secret))]);}
  await c.query('COMMIT');return {connected:!!result.access_token,interval:secret.interval};
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}});
}
export async function sweepUsage(){await withAdvisoryLock(727811,async()=>{
 const s=(await pool.query('SELECT * FROM usage_reporting WHERE singleton AND next_attempt_at<=now()')).rows[0],cfg=await config();if(!s)return;
 if(!s.consent&&!s.withdrawal_pending)return;
 if(!s.consent&&(!s.secret||new Date(s.withdrawal_until).getTime()<Date.now())){await pool.query('UPDATE usage_reporting SET secret=NULL,installation_id=NULL,withdrawal_pending=false WHERE singleton AND NOT consent');return;}
 if(!cfg.configured||s.policy_hash!==cfg.policyHash)return;
 let secret=readSecret(s);const day=new Date().toISOString().slice(0,10),version=(process.env.APP_VERSION||'0.9.1.2').replace(/^v/,'');
 if(!s.consent&&(!secret.access_token||new Date(s.withdrawal_until).getTime()<Date.now())){await pool.query('UPDATE usage_reporting SET secret=NULL,installation_id=NULL,withdrawal_pending=false WHERE singleton AND NOT consent');return;}
 if(s.consent&&(!secret.access_token||!s.last_activity_at||Date.now()-new Date(s.last_activity_at).getTime()>86400000||String(s.last_report_day?.toISOString?.().slice(0,10)||s.last_report_day)===day&&s.last_report_version===version))return;
 try{
  if(secret.expires&&secret.expires<Date.now()+60000){if(!secret.refresh_token)throw Error('Reconnect GitHub');const fresh=await github('https://github.com/login/oauth/access_token',{client_id:cfg.clientId,grant_type:'refresh_token',refresh_token:secret.refresh_token});if(typeof fresh.access_token!=='string')throw Error('Reconnect GitHub');secret={access_token:fresh.access_token,refresh_token:fresh.refresh_token,expires:fresh.expires_in?Date.now()+fresh.expires_in*1000:null};await pool.query('UPDATE usage_reporting SET secret=$1 WHERE singleton AND installation_id=$2',[encrypt(JSON.stringify(secret)),s.installation_id]);}
  // Recheck consent immediately before sending; withdrawal can race a sweep.
  const current=(await pool.query('SELECT consent,installation_id,policy_hash FROM usage_reporting WHERE singleton')).rows[0];if(current.installation_id!==s.installation_id||current.consent!==s.consent||current.policy_hash!==cfg.policyHash)return;
  const report:UsageReport={schema:1,kind:s.consent?'heartbeat':'withdraw',id:s.installation_id,day,...(s.consent?{version}:{})};
  await github('https://api.github.com/repos/'+cfg.repository+'/issues',{title:'Fledge encrypted usage report',body:'fledge-usage-v1\n'+JSON.stringify(sealUsageReport(report,cfg.publicKey))},secret.access_token);
  if(s.consent)await pool.query("UPDATE usage_reporting SET last_report_day=$1,last_report_version=$2,last_error=NULL,next_attempt_at=now()+interval '1 hour' WHERE singleton AND consent AND installation_id=$3",[day,version,s.installation_id]);
  else await pool.query('UPDATE usage_reporting SET secret=NULL,installation_id=NULL,withdrawal_pending=false,last_error=NULL WHERE singleton AND NOT consent AND installation_id=$1',[s.installation_id]);
 }catch{await pool.query("UPDATE usage_reporting SET last_error='GitHub reporting is unavailable. Check the intake or reconnect GitHub.',next_attempt_at=now()+interval '1 hour' WHERE singleton");}
 });}
