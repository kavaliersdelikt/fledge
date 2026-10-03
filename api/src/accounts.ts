import type {FastifyInstance} from 'fastify';
import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import {pool,admin,fail,txt,asId,hash,token,passwordHash,audit,WEB_ORIGIN,looksLikeEmail} from './core.js';
import {mailerReady,sendMail} from './mailer.js';
import {sendTemplate,render} from './email.js';
import {templateById} from './email-defaults.js';
import {settings} from './settings.js';
import {brand} from './branding.js';
import {ipAllowed} from './cidr.js';
import {mfaFailed,mfaLocked} from './auth.js';

// Account security: your signed-in devices, one-time email links (invitations and password
// resets) and passkeys.

const pass=(s:any)=>{if(typeof s!=='string'||s.length<12||s.length>1024)fail(400,'Password must be 12–1024 characters');return s as string;};
const sessionOf=(req:any)=>{const c=req.cookies?.fledge_session;return c?hash(c):null;};
const cookieOnly=(req:any)=>{if(req.actor?.tokenScopes||!req.cookies?.fledge_session)fail(403,'Browser session required');};

// --- WebAuthn settings ----------------------------------------------------------------------------
const origins=()=>(process.env.WEBAUTHN_ORIGINS||WEB_ORIGIN).split(',').map(s=>s.trim().replace(/\/$/,'')).filter(Boolean);
const rpID=()=>process.env.WEBAUTHN_RP_ID||new URL(origins()[0]).hostname;
const b64=(u:Uint8Array)=>Buffer.from(u).toString('base64url');

async function saveChallenge(userId:string,kind:string,challenge:string){
 await pool.query("INSERT INTO webauthn_challenges(user_id,kind,challenge,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes') ON CONFLICT(user_id,kind) DO UPDATE SET challenge=EXCLUDED.challenge,expires_at=EXCLUDED.expires_at",[userId,kind,challenge]);
}
async function takeChallenge(userId:string,kind:string){
 const r=await pool.query("DELETE FROM webauthn_challenges WHERE user_id=$1 AND kind=$2 AND expires_at>now() RETURNING challenge",[userId,kind]);
 if(!r.rowCount)fail(400,'The passkey request expired. Start again.');
 return r.rows[0].challenge as string;
}
const credentialOf=(row:any)=>({id:row.id as string,publicKey:new Uint8Array(row.public_key),counter:Number(row.counter),transports:row.transports as any[]});

async function mailLink(kind:'invite'|'reset',user:{id:string;email:string},ttl:string){
 const raw=token();
 await pool.query("DELETE FROM user_tokens WHERE user_id=$1 AND kind=$2",[user.id,kind]);
 await pool.query("INSERT INTO user_tokens(token_hash,user_id,kind,expires_at) VALUES($1,$2,$3,now()+$4::interval)",[hash(raw),user.id,kind,ttl]);
 const link=`${WEB_ORIGIN.replace(/\/$/,'')}/?token=${raw}`;
 let sent=false;
 if(await mailerReady()){
  // Sent straight away; if the mail server is down the message is kept and retried instead of being lost.
  const r=await sendTemplate(kind==='invite'?'invite':'password_reset',user.email,{link,days:'7',duration:'one hour'},{userId:user.id,inline:true});
  sent=r.status==='sent'||r.status==='queued';
 }
 return {sent,link};
}
export {mailLink};

export function accountRoutes(app:FastifyInstance){
 // --- Sessions -------------------------------------------------------------------------------------
 app.get('/api/auth/sessions',async(req)=>{
  cookieOnly(req);
  const cur=sessionOf(req);
  return (await pool.query("SELECT id,token_hash,ip,user_agent,created_at,last_seen_at,expires_at FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY last_seen_at DESC",[req.actor!.id])).rows
   .map((r:any)=>({id:r.id,ip:r.ip,userAgent:r.user_agent,createdAt:r.created_at,lastSeenAt:r.last_seen_at,expiresAt:r.expires_at,current:r.token_hash===cur}));
 });
 app.delete('/api/auth/sessions/:id',async(req,reply)=>{
  cookieOnly(req);
  const r=await pool.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING token_hash',[asId((req.params as any).id),req.actor!.id]);
  if(!r.rowCount)fail(404,'Session not found');
  if(r.rows[0].token_hash===sessionOf(req))reply.clearCookie('fledge_session',{path:'/'});
  await audit(req.actor!.id,'session.revoke','user',req.actor!.id);
  return {ok:true};
 });
 app.post('/api/auth/sessions/revoke-others',async(req)=>{
  cookieOnly(req);
  const r=await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[req.actor!.id,sessionOf(req)]);
  await audit(req.actor!.id,'session.revoke_others','user',req.actor!.id,{count:r.rowCount});
  return {ok:true,revoked:r.rowCount};
 });
 app.post('/api/customers/:id/sign-out',async(req)=>{
  admin(req);
  const id=asId((req.params as any).id);
  const r=await pool.query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=$1 AND role='customer')",[id]);
  await audit(req.actor!.id,'customer.sign_out','user',id,{count:r.rowCount});
  return {ok:true,revoked:r.rowCount};
 });

 // --- Email links: invitations and password resets -----------------------------------------------------------------
 app.post('/api/customers/:id/invite',async(req)=>{
  admin(req);
  const u=(await pool.query("SELECT id,email FROM users WHERE id=$1 AND role='customer' AND NOT disabled",[asId((req.params as any).id)])).rows[0];
  if(!u)fail(404,'Customer not found');
  const r=await mailLink('invite',u,'7 days');
  await audit(req.actor!.id,'customer.invite','user',u.id,{emailed:r.sent});
  // Without email set up the administrator gets the link to pass on themselves.
  return r.sent?{sent:true}:{sent:false,link:r.link};
 });
 app.post('/api/auth/forgot',async(req)=>{
  const email=txt((req.body as any)?.email,254).toLowerCase();
  const key=hash('forgot:'+email);
  const t=(await pool.query("INSERT INTO login_attempts(bucket_hash,attempts,expires_at) VALUES($1,1,now()+interval '1 hour') ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN login_attempts.expires_at<=now() THEN 1 ELSE login_attempts.attempts+1 END,expires_at=CASE WHEN login_attempts.expires_at<=now() THEN now()+interval '1 hour' ELSE login_attempts.expires_at END RETURNING attempts",[key])).rows[0];
  // The answer never reveals whether the address has an account.
  if(t.attempts<=3&&await mailerReady()){
   const u=(await pool.query('SELECT id,email FROM users WHERE email=$1 AND NOT disabled',[email])).rows[0];
   if(u)mailLink('reset',u,'1 hour').then(()=>audit(null,'password.reset_requested','user',u.id)).catch(e=>req.log.error(e,'password reset mail failed'));
  }
  return {ok:true};
 });
 app.post('/api/auth/token/accept',async(req)=>{
  const b=req.body as any,password=pass(b?.password);
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const t=(await c.query("DELETE FROM user_tokens WHERE token_hash=$1 AND expires_at>now() RETURNING user_id,kind",[hash(String(b?.token||''))])).rows[0];
   if(!t)fail(400,'This link has expired or was already used. Ask for a new one.');
   const u=(await c.query('UPDATE users SET password_hash=$2 WHERE id=$1 AND NOT disabled RETURNING id,email,role',[t.user_id,await passwordHash(password)])).rows[0];
   if(!u)fail(400,'This account is not available');
   await c.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);
   if(t.kind==='reset')await c.query('DELETE FROM api_tokens WHERE user_id=$1',[u.id]);
   await c.query('DELETE FROM user_tokens WHERE user_id=$1',[u.id]);
   await c.query('COMMIT');
   await audit(u.id,t.kind==='invite'?'invite.accepted':'password.reset','user',u.id);
   if(t.kind==='reset')void sendTemplate('password_changed',u.email,{when:new Date().toUTCString()},{userId:u.id}).catch(()=>{});
   return {ok:true,email:u.email,kind:t.kind};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 });
 app.post('/api/settings/email/test',async(req)=>{
  admin(req);
  const to=txt((req.body as any)?.to,254);
  if(!looksLikeEmail(to))fail(400,'Enter a valid email address');
  // Sent directly (not queued) so the administrator sees the mail server's answer.
  const r=await render(templateById('test')!,{email:to});
  await sendMail({to,subject:r.subject,text:r.text,html:r.html,raw:true});
  await audit(req.actor!.id,'settings.email.test','settings','email');
  return {ok:true};
 });
 // Saving an allow-list that excludes the administrator's own address would lock them out.
 app.post('/api/settings/security/check',async(req)=>{
  admin(req);
  const list=(req.body as any)?.adminAllowedCidrs;
  if(!Array.isArray(list))fail(400,'adminAllowedCidrs must be a list');
  return {yourAddress:req.ip,allowed:ipAllowed(req.ip,list.map(String))};
 });

 // --- Passkeys ----------------------------------------------------------------------------------------------------------------
 app.get('/api/auth/passkeys',async(req)=>{
  cookieOnly(req);
  return (await pool.query('SELECT id,name,device_type AS "deviceType",backed_up AS "backedUp",created_at AS "createdAt",last_used_at AS "lastUsedAt" FROM passkeys WHERE user_id=$1 ORDER BY created_at',[req.actor!.id])).rows;
 });
 app.post('/api/auth/passkeys/options',async(req)=>{
  cookieOnly(req);
  const existing=(await pool.query('SELECT id,transports FROM passkeys WHERE user_id=$1',[req.actor!.id])).rows;
  if(existing.length>=10)fail(409,'You can register at most 10 passkeys');
  const options=await generateRegistrationOptions({rpName:(await brand()).name,rpID:rpID(),userName:req.actor!.email,userID:new TextEncoder().encode(req.actor!.id),attestationType:'none',
   excludeCredentials:existing.map((p:any)=>({id:p.id,transports:p.transports})),authenticatorSelection:{residentKey:'preferred',userVerification:'preferred'}});
  await saveChallenge(req.actor!.id,'register',options.challenge);
  return options;
 });
 app.post('/api/auth/passkeys/verify',async(req)=>{
  cookieOnly(req);
  const b=req.body as any,challenge=await takeChallenge(req.actor!.id,'register');
  let result;
  try{result=await verifyRegistrationResponse({response:b?.response,expectedChallenge:challenge,expectedOrigin:origins(),expectedRPID:rpID(),requireUserVerification:false});}
  catch(e:any){return fail(400,`The passkey could not be verified: ${String(e?.message||'invalid response').slice(0,160)}`);}
  const info=result.registrationInfo;
  if(!result.verified||!info)throw Object.assign(new Error('The passkey could not be verified'),{statusCode:400});
  const {credential,credentialDeviceType,credentialBackedUp}=info;
  const name=b?.name?txt(b.name,60):'Passkey';
  try{
   await pool.query('INSERT INTO passkeys(id,user_id,public_key,counter,transports,name,device_type,backed_up) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[credential.id,req.actor!.id,Buffer.from(credential.publicKey),credential.counter,credential.transports||[],name,credentialDeviceType,credentialBackedUp]);
  }catch(e:any){if(e?.code==='23505')fail(409,'This passkey is already registered');throw e;}
  await audit(req.actor!.id,'passkey.add','user',req.actor!.id,{name});
  return {ok:true,id:credential.id,name};
 });
 app.delete('/api/auth/passkeys/:id',async(req)=>{
  cookieOnly(req);
  const r=await pool.query('DELETE FROM passkeys WHERE id=$1 AND user_id=$2',[String((req.params as any).id).slice(0,512),req.actor!.id]);
  if(!r.rowCount)fail(404,'Passkey not found');
  await audit(req.actor!.id,'passkey.remove','user',req.actor!.id);
  return {ok:true};
 });
 // Second factor at sign-in: the login challenge from /api/auth/login (stepwise) is exchanged for a passkey assertion.
 app.post('/api/auth/passkey/options',async(req)=>{
  const ch=(await pool.query("SELECT * FROM auth_challenges WHERE token_hash=$1 AND expires_at>now() AND attempts<5",[hash(String((req.body as any)?.challenge||''))])).rows[0];
  if(!ch)fail(401,'Verification expired. Sign in again.');
  const keys=(await pool.query('SELECT id,transports FROM passkeys WHERE user_id=$1',[ch.user_id])).rows;
  if(!keys.length)fail(400,'This account has no passkeys');
  const options=await generateAuthenticationOptions({rpID:rpID(),allowCredentials:keys.map((k:any)=>({id:k.id,transports:k.transports})),userVerification:'preferred'});
  await saveChallenge(ch.user_id,'login',options.challenge);
  return options;
 });
 app.post('/api/auth/passkey/verify',async(req,reply)=>{
  const b=req.body as any,ch=(await pool.query("SELECT * FROM auth_challenges WHERE token_hash=$1 AND expires_at>now() AND attempts<5",[hash(String(b?.challenge||''))])).rows[0];
  if(!ch)fail(401,'Verification expired. Sign in again.');
  const user=(await pool.query('SELECT * FROM users WHERE id=$1 AND NOT disabled',[ch.user_id])).rows[0];
  const bad=async(message:string)=>{await pool.query('UPDATE auth_challenges SET attempts=attempts+1 WHERE token_hash=$1',[ch.token_hash]);await mfaFailed(ch.user_id);return fail(401,message);};
  if(await mfaLocked(ch.user_id))fail(429,'Too many failed verification attempts; try again later');
  if(!user)return bad('Invalid passkey');
  const key=(await pool.query('SELECT * FROM passkeys WHERE id=$1 AND user_id=$2',[String(b?.response?.id||''),user.id])).rows[0];
  if(!key)return bad('Invalid passkey');
  const expected=await takeChallenge(user.id,'login').catch(()=>null);
  if(!expected)return bad('The passkey request expired. Start again.');
  let v;
  try{v=await verifyAuthenticationResponse({response:b.response,expectedChallenge:expected,expectedOrigin:origins(),expectedRPID:rpID(),credential:credentialOf(key),requireUserVerification:false});}
  catch{return bad('Invalid passkey');}
  if(!v.verified)return bad('Invalid passkey');
  await pool.query('UPDATE passkeys SET counter=$2,last_used_at=now() WHERE id=$1',[key.id,v.authenticationInfo.newCounter]);
  await pool.query('DELETE FROM auth_challenges WHERE token_hash=$1',[ch.token_hash]);
  const value=token(),r=reply.request;
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at,ip,user_agent) VALUES($1,$2,now()+interval '7 days',$3,$4)",[user.id,hash(value),String(r.ip||'').slice(0,64)||null,String(r.headers['user-agent']||'').slice(0,300)||null]);
  reply.setCookie('fledge_session',value,{path:'/',httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:7*86400});
  await audit(user.id,'login','user',user.id,{method:'passkey'});
  return {id:user.id,email:user.email,role:user.role};
 });
}
void settings;void b64;
