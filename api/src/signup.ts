import type {FastifyInstance} from 'fastify';
import {randomBytes} from 'node:crypto';
import {pool,admin,fail,txt,asId,hash,token,passwordHash,passwordCheck,audit,WEB_ORIGIN,looksLikeEmail} from './core.js';
import {settings} from './settings.js';
import {mailerReady} from './mailer.js';
import {sendTemplate,sendToAdmins} from './email.js';
import {emit,notifyUser} from './notifications.js';
import {safeRequest} from './netguard.js';
import {DISPOSABLE_DOMAINS,weakPassword,domainOf,domainMatches} from './signup-data.js';

// Self-registration: sign up, confirm the address, optional approval, invite-only mode,
// account changes (email, deletion) and a data export. Off by default (Settings, Sign-up).
// Nothing is created for an unconfirmed address, the answer never reveals whether an
// address already has an account, and every step is rate limited.

const GENERIC={ok:true,message:'If this address can be registered, a confirmation link is on its way. It can take a few minutes to arrive.'};
const origin=()=>WEB_ORIGIN.replace(/\/$/,'');

/** Registered by other modules (billing) to run when an account becomes active. */
const activationHooks:((userId:string)=>Promise<void>)[]=[];
export const onActivated=(fn:(userId:string)=>Promise<void>)=>{activationHooks.push(fn);};

/** Counts an attempt in a fixed window; returns how many there have been (including this one). */
export async function bump(key:string,seconds:number):Promise<number>{
 const k=hash(key),r=await pool.query(`INSERT INTO request_limits(bucket_hash,attempts,expires_at) VALUES($1,1,now()+make_interval(secs=>$2))
  ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN request_limits.expires_at<=now() THEN 1 ELSE request_limits.attempts+1 END,
  expires_at=CASE WHEN request_limits.expires_at<=now() THEN now()+make_interval(secs=>$2) ELSE request_limits.expires_at END RETURNING attempts`,[k,seconds]);
 return Number(r.rows[0].attempts);
}

async function verifyCaptcha(provider:'turnstile'|'hcaptcha',secret:string,siteKey:string,response:unknown,ip:string){
 if(typeof response!=='string'||!response||response.length>4096)return false;
 const override=process.env.FLEDGE_TEST_CAPTCHA_URL;
 const url=override||(provider==='turnstile'?'https://challenges.cloudflare.com/turnstile/v0/siteverify':'https://api.hcaptcha.com/siteverify');
 const form=new URLSearchParams({secret,response,remoteip:ip,...(provider==='hcaptcha'?{sitekey:siteKey}:{})}).toString();
 try{
  const r=await safeRequest(url,{method:'POST',body:form,maxBytes:64*1024,timeoutMs:8000,redirects:0,headers:{'content-type':'application/x-www-form-urlencoded'},...(override?{allowHttp:true,allowPrivate:true}:{})} as any);
  return r.status===200&&JSON.parse(r.body.toString('utf8')).success===true;
 }catch{return false;}
}

export async function issueToken(userId:string,kind:'verify'|'email_change',ttl:string,payload:Record<string,unknown>={}){
 const raw=token();
 await pool.query('DELETE FROM user_tokens WHERE user_id=$1 AND kind=$2',[userId,kind]);
 await pool.query('INSERT INTO user_tokens(token_hash,user_id,kind,expires_at,payload) VALUES($1,$2,$3,now()+$4::interval,$5)',[hash(raw),userId,kind,ttl,JSON.stringify(payload)]);
 return raw;
}

async function sendVerification(user:{id:string;email:string}){
 const raw=await issueToken(user.id,'verify','24 hours');
 return sendTemplate('verify_email',user.email,{link:`${origin()}/?verify=${raw}`,hours:'24'},{userId:user.id,inline:true});
}

/** An account that may sign in and use the panel. */
export async function activate(userId:string,source:string){
 const u=(await pool.query("UPDATE users SET status='active' WHERE id=$1 AND status<>'active' RETURNING id,email",[userId])).rows[0];
 if(!u)return;
 const cfg=(await settings()).signup;
 await audit(null,'signup.activated','user',u.id,{source});
 if(cfg.welcomeEmail)void sendTemplate('welcome',u.email,{},{userId:u.id,dedupeKey:`welcome:${u.id}`}).catch(()=>{});
 for(const fn of activationHooks)await fn(u.id).catch(e=>console.error('Activation hook failed:',e?.message));
}

export function signupRoutes(app:FastifyInstance){
 // What the sign-up form needs to know. Public.
 app.get('/api/signup/config',async()=>{
  const c=(await settings()).signup;
  return {mode:c.mode,captcha:c.captchaProvider==='none'?null:{provider:c.captchaProvider,siteKey:c.captchaSiteKey},requireTerms:c.requireTerms,termsUrl:c.termsUrl,privacyUrl:c.privacyUrl,minPasswordLength:c.minPasswordLength,termsVersion:c.termsVersion,
   available:c.mode!=='off'&&await mailerReady()};
 });

 app.post('/api/auth/register',async(req)=>{
  const cfg=(await settings()).signup,b=req.body as any;
  if(cfg.mode==='off')fail(404,'Sign-up is not available');
  if(!(await mailerReady()))fail(503,'Sign-up is temporarily unavailable.');
  // Cheap bot traps: a hidden field a person never fills in, and a form that was submitted too fast.
  if(typeof b?.website==='string'&&b.website.trim())return GENERIC;
  if(Number.isFinite(Number(b?.t))&&Date.now()-Number(b.t)<1500)return GENERIC;
  const email=txt(b?.email,254).toLowerCase();
  if(!looksLikeEmail(email))fail(400,'Enter a valid email address');
  const domain=domainOf(email);
  if(cfg.allowedDomains.length&&!domainMatches(domain,cfg.allowedDomains))fail(400,'Sign-up is limited to specific email providers. Use your organisation’s address.');
  if(domainMatches(domain,cfg.blockedDomains)||(cfg.blockDisposable&&domainMatches(domain,DISPOSABLE_DOMAINS)))fail(400,'That email provider is not accepted. Use a permanent address.');
  const password=String(b?.password??'');
  if(password.length<cfg.minPasswordLength||password.length>1024)fail(400,`Password must be at least ${cfg.minPasswordLength} characters`);
  if(cfg.rejectCommonPasswords){const weak=weakPassword(password,email);if(weak)fail(400,weak);}
  if(cfg.requireTerms&&b?.acceptTerms!==true)fail(400,'Please accept the terms to continue.');
  if(cfg.captchaProvider!=='none'&&!await verifyCaptcha(cfg.captchaProvider,cfg.captchaSecret,cfg.captchaSiteKey,b?.captcha,req.ip))fail(400,'Please complete the check and try again.');
  let invite:any=null;
  if(cfg.mode==='invite'){
   const code=String(b?.inviteCode??'').trim();
   if(!code)fail(400,'Sign-up needs an invitation code.');
   invite=(await pool.query('SELECT * FROM signup_invites WHERE code_hash=$1 AND expires_at>now() AND uses<max_uses',[hash(code)])).rows[0];
   if(!invite||(invite.email&&invite.email.toLowerCase()!==email))fail(400,'That invitation is not valid.');
  }
  // Only attempts that pass every check count towards the limits, so a mistyped password never locks anyone out.
  // A flood of sign-ups pauses sign-up for everyone and tells the administrators.
  if(await bump('signup:global',3600)>cfg.globalPerHour){
   void emit({kind:'signup.pending',severity:'warn',title:'Sign-up paused: too many registrations',body:`More than ${cfg.globalPerHour} registrations in an hour. Sign-up resumes by itself.`,dedupe:{key:'signup-flood',minutes:60}});
   fail(429,'Sign-up is very busy right now. Please try again in a little while.');
  }
  if(await bump(`signup:ip:${req.ip}`,3600)>cfg.perIpPerHour)fail(429,'Too many sign-up attempts from your network. Try again later.');
  if(await bump(`signup:email:${email}`,86400)>cfg.perEmailPerDay)fail(429,'Too many attempts for this address. Try again tomorrow.');
  // Hash first so a new and an existing address take about the same time.
  const pwHash=await passwordHash(password);
  const existing=(await pool.query('SELECT id,status,disabled FROM users WHERE email=$1',[email])).rows[0];
  if(existing){
   if(existing.status==='pending_verification'&&!existing.disabled){
    if(await bump(`verify:${existing.id}`,3600)<=3)void sendVerification({id:existing.id,email}).catch(()=>{});
   }else if(!existing.disabled){
    void sendTemplate('already_registered',email,{},{userId:existing.id,dedupeKey:`already:${existing.id}:${new Date().toISOString().slice(0,13)}`}).catch(()=>{});
   }
   return GENERIC;
  }
  const c=await pool.connect();
  let user:any;
  try{
   await c.query('BEGIN');
   if(invite){const used=await c.query('UPDATE signup_invites SET uses=uses+1 WHERE id=$1 AND uses<max_uses RETURNING id',[invite.id]);if(!used.rowCount)fail(400,'That invitation is not valid.');}
   user=(await c.query(`INSERT INTO users(email,password_hash,role,status,signup_source,terms_version,terms_accepted_at,terms_ip_hash) VALUES($1,$2,'customer','pending_verification',$3,$4,$5,$6) RETURNING id,email`,
    [email,pwHash,cfg.mode==='invite'?'invite':'signup',cfg.requireTerms?cfg.termsVersion:null,cfg.requireTerms?new Date():null,cfg.requireTerms?hash('ip:'+req.ip):null])).rows[0];
   if(invite?.plan_id)await c.query('UPDATE users SET preferences=jsonb_set(preferences,\'{invitePlan}\',to_jsonb($2::text)) WHERE id=$1',[user.id,invite.plan_id]);
   await c.query('COMMIT');
  }catch(e:any){await c.query('ROLLBACK').catch(()=>{});if(e?.code==='23505')return GENERIC;throw e;}finally{c.release();}
  await audit(null,'signup.register','user',user.id,{source:cfg.mode});
  await sendVerification(user).catch(()=>{});
  return GENERIC;
 });

 app.post('/api/auth/verify/resend',async(req)=>{
  const email=String((req.body as any)?.email??'').trim().toLowerCase();
  if(!looksLikeEmail(email))return GENERIC;
  if(await bump(`resend:ip:${req.ip}`,3600)>5||await bump(`resend:${email}`,3600)>3)return GENERIC;
  const u=(await pool.query("SELECT id,email FROM users WHERE email=$1 AND status='pending_verification' AND NOT disabled",[email])).rows[0];
  if(u&&await mailerReady())void sendVerification(u).catch(()=>{});
  return GENERIC;
 });

 app.post('/api/auth/verify',async(req)=>{
  const raw=String((req.body as any)?.token??'');
  if(await bump(`verify:ip:${req.ip}`,3600)>30)fail(429,'Too many attempts. Try again later.');
  const t=(await pool.query("DELETE FROM user_tokens WHERE token_hash=$1 AND kind='verify' AND expires_at>now() RETURNING user_id",[hash(raw)])).rows[0];
  if(!t)fail(400,'This link has expired or was already used. Request a new one from the sign-in page.');
  const cfg=(await settings()).signup;
  const u=(await pool.query("UPDATE users SET email_verified_at=now() WHERE id=$1 AND NOT disabled RETURNING id,email,status,signup_source",[t.user_id])).rows[0];
  if(!u)fail(400,'This account is not available.');
  if(u.status==='pending_verification'){
   const needsApproval=cfg.mode==='approval'&&u.signup_source!=='invite';
   if(needsApproval){
    await pool.query("UPDATE users SET status='pending_approval' WHERE id=$1",[u.id]);
    await audit(null,'signup.verified','user',u.id,{next:'approval'});
    void sendTemplate('approval_pending',u.email,{},{userId:u.id}).catch(()=>{});
    if(cfg.notifyAdmins){
     void emit({kind:'signup.pending',title:`${u.email} is waiting for approval`,body:'Open Customers to approve or decline the account.',severity:'info'});
     void sendToAdmins('admin_approval_needed',{customerEmail:u.email,link:`${origin()}/customers`},`approval:${u.id}`).catch(()=>{});
    }
    return {ok:true,status:'pending_approval'};
   }
   await audit(null,'signup.verified','user',u.id,{next:'active'});
   await activate(u.id,'verification');
  }
  return {ok:true,status:'active'};
 });

 // ---- Administrators ----
 app.get('/api/signup/pending',async(req)=>{
  admin(req);
  return (await pool.query("SELECT id,email,status,signup_source AS \"source\",created_at AS \"createdAt\",email_verified_at AS \"verifiedAt\" FROM users WHERE status IN ('pending_verification','pending_approval') ORDER BY created_at DESC LIMIT 200")).rows;
 });
 const pendingUser=async(id:string)=>{const u=(await pool.query("SELECT id,email,status FROM users WHERE id=$1 AND role='customer'",[id])).rows[0];if(!u)fail(404,'Customer not found');return u as {id:string;email:string;status:string};};
 app.post('/api/customers/:id/approve',async(req)=>{
  admin(req);const u=await pendingUser(asId((req.params as any).id));
  if(u.status!=='pending_approval')fail(409,'This account is not waiting for approval');
  await activate(u.id,'approval');
  void sendTemplate('account_approved',u.email,{},{userId:u.id}).catch(()=>{});
  await audit(req.actor!.id,'signup.approve','user',u.id);
  return {ok:true};
 });
 app.post('/api/customers/:id/reject',async(req)=>{
  admin(req);const u=await pendingUser(asId((req.params as any).id));
  if(!['pending_approval','pending_verification'].includes(u.status))fail(409,'Only accounts that have not been approved can be declined');
  // Sent (and recorded) before the account goes away; the log keeps no link to a deleted person.
  await sendTemplate('account_rejected',u.email,{}).catch(()=>{});
  await pool.query('DELETE FROM users WHERE id=$1',[u.id]);
  await audit(req.actor!.id,'signup.reject','user',u.id,{email:u.email});
  return {ok:true};
 });
 app.post('/api/customers/:id/mark-verified',async(req)=>{
  admin(req);const u=await pendingUser(asId((req.params as any).id));
  if(u.status!=='pending_verification')fail(409,'This account is already verified');
  await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[u.id]);
  await activate(u.id,'admin-verified');
  await audit(req.actor!.id,'signup.mark_verified','user',u.id);
  return {ok:true};
 });
 app.post('/api/customers/:id/resend-verification',async(req)=>{
  admin(req);const u=await pendingUser(asId((req.params as any).id));
  if(u.status!=='pending_verification')fail(409,'This account is already verified');
  if(!(await mailerReady()))fail(409,'Email is not set up.');
  await sendVerification(u);
  return {ok:true};
 });

 app.get('/api/signup/invites',async(req)=>{
  admin(req);
  return (await pool.query('SELECT id,email,note,expires_at AS "expiresAt",max_uses AS "maxUses",uses,plan_id AS "planId",created_at AS "createdAt" FROM signup_invites ORDER BY created_at DESC LIMIT 200')).rows;
 });
 app.post('/api/signup/invites',async(req)=>{
  admin(req);
  const b=req.body as any;
  const days=Number(b?.expiresInDays??14);
  if(!Number.isInteger(days)||days<1||days>365)fail(400,'Invitations last 1 to 365 days');
  const uses=Number(b?.maxUses??1);
  if(!Number.isInteger(uses)||uses<1||uses>10000)fail(400,'Uses must be between 1 and 10000');
  const email=b?.email?txt(b.email,254).toLowerCase():null;
  if(email&&!looksLikeEmail(email))fail(400,'Enter a valid email address');
  const planId=b?.planId?asId(b.planId):null;
  const code=randomBytes(12).toString('base64url');
  const row=(await pool.query("INSERT INTO signup_invites(code_hash,email,note,created_by,expires_at,max_uses,plan_id) VALUES($1,$2,$3,$4,now()+make_interval(days=>$5),$6,$7) RETURNING id,expires_at AS \"expiresAt\"",[hash(code),email,b?.note?txt(b.note,200):null,req.actor!.id,days,uses,planId])).rows[0];
  await audit(req.actor!.id,'signup.invite.create','signup_invite',row.id,{email,uses});
  return {...row,code,link:`${origin()}/?invite=${code}`};
 });
 app.delete('/api/signup/invites/:id',async(req)=>{
  admin(req);
  const r=await pool.query('DELETE FROM signup_invites WHERE id=$1 RETURNING id',[asId((req.params as any).id)]);
  if(!r.rowCount)fail(404,'Invitation not found');
  await audit(req.actor!.id,'signup.invite.delete','signup_invite',r.rows[0].id);
  return {ok:true};
 });

 // ---- A signed-in person's own account ----
 const browserOnly=(req:any)=>{if(req.actor?.tokenScopes||!req.cookies?.fledge_session)fail(403,'Browser session required');};
 const ownPassword=async(req:any,password:unknown)=>{
  const u=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.actor.id])).rows[0];
  if(await bump(`reauth:${req.actor.id}`,900)>8)fail(429,'Too many attempts. Try again in a few minutes.');
  if(typeof password!=='string'||!await passwordCheck(password,u.password_hash))fail(403,'That password is not correct.');
 };
 app.post('/api/account/email',async(req)=>{
  browserOnly(req);
  const cfg=(await settings()).signup;
  if(!cfg.allowEmailChange)fail(403,'Changing the email address is turned off.');
  if(!(await mailerReady()))fail(409,'Email is not set up, so the new address cannot be confirmed.');
  const b=req.body as any,email=txt(b?.email,254).toLowerCase();
  if(!looksLikeEmail(email))fail(400,'Enter a valid email address');
  await ownPassword(req,b?.password);
  if(email===req.actor!.email)fail(400,'That is already your address.');
  const domain=domainOf(email);
  if(domainMatches(domain,cfg.blockedDomains)||(cfg.blockDisposable&&domainMatches(domain,DISPOSABLE_DOMAINS)))fail(400,'That email provider is not accepted.');
  if(await bump(`emailchange:${req.actor!.id}`,86400)>5)fail(429,'Too many changes today.');
  if((await pool.query('SELECT 1 FROM users WHERE email=$1',[email])).rowCount)return {ok:true};
  const raw=await issueToken(req.actor!.id,'email_change','24 hours',{email});
  await sendTemplate('email_change_verify',email,{link:`${origin()}/?confirm-email=${raw}`,newEmail:email,hours:'24'},{userId:req.actor!.id,inline:true});
  await audit(req.actor!.id,'account.email_change.request','user',req.actor!.id);
  return {ok:true};
 });
 app.post('/api/auth/email/confirm',async(req)=>{
  if(await bump(`confirm:ip:${req.ip}`,3600)>30)fail(429,'Too many attempts. Try again later.');
  const t=(await pool.query("DELETE FROM user_tokens WHERE token_hash=$1 AND kind='email_change' AND expires_at>now() RETURNING user_id,payload",[hash(String((req.body as any)?.token??''))])).rows[0];
  if(!t)fail(400,'This link has expired or was already used.');
  const email=String(t.payload?.email||'');
  const old=(await pool.query('SELECT email FROM users WHERE id=$1',[t.user_id])).rows[0];
  if(!old||!looksLikeEmail(email))fail(400,'This link is not valid.');
  try{await pool.query('UPDATE users SET email=$2,email_verified_at=now() WHERE id=$1',[t.user_id,email]);}
  catch(e:any){if(e?.code==='23505')fail(409,'That address is already in use.');throw e;}
  await audit(t.user_id,'account.email_change','user',t.user_id);
  void sendTemplate('email_changed',old.email,{newEmail:email},{userId:t.user_id}).catch(()=>{});
  return {ok:true,email};
 });

 app.post('/api/account/delete',async(req)=>{
  browserOnly(req);
  const cfg=(await settings()).signup;
  if(req.actor!.role!=='customer')fail(403,'Administrator accounts cannot be deleted here.');
  if(!cfg.allowAccountDeletion)fail(403,'Deleting your account is turned off. Contact support.');
  await ownPassword(req,(req.body as any)?.password);
  const servers=Number((await pool.query('SELECT count(*) n FROM servers WHERE owner_id=$1 AND deleted_at IS NULL',[req.actor!.id])).rows[0].n);
  if(servers)fail(409,'Delete your servers first. Deleting an account does not delete servers by itself.');
  const subs=Number((await pool.query("SELECT count(*) n FROM subscriptions WHERE user_id=$1 AND status NOT IN ('canceled','terminated')",[req.actor!.id])).rows[0].n);
  if(subs)fail(409,'Cancel your subscriptions first.');
  const when=(await pool.query("UPDATE users SET status='deletion_pending',deletion_at=now()+make_interval(days=>$2) WHERE id=$1 RETURNING deletion_at",[req.actor!.id,cfg.deletionGraceDays])).rows[0].deletion_at as Date;
  await audit(req.actor!.id,'account.delete.request','user',req.actor!.id,{at:when});
  void sendTemplate('deletion_scheduled',req.actor!.email,{date:new Date(when).toUTCString().slice(5,16)},{userId:req.actor!.id}).catch(()=>{});
  if(cfg.deletionGraceDays===0)await finishDeletions();
  return {ok:true,deletionAt:when};
 });
 app.post('/api/account/delete/cancel',async(req)=>{
  browserOnly(req);
  const r=await pool.query("UPDATE users SET status='active',deletion_at=NULL WHERE id=$1 AND status='deletion_pending' RETURNING id",[req.actor!.id]);
  if(!r.rowCount)fail(409,'No deletion is scheduled.');
  await audit(req.actor!.id,'account.delete.cancel','user',req.actor!.id);
  return {ok:true};
 });
 app.get('/api/account/export',async(req,reply)=>{
  browserOnly(req);
  if(!(await settings()).signup.allowDataExport&&req.actor!.role!=='admin')fail(403,'Data export is turned off.');
  const id=req.actor!.id;
  const q=async(sql:string)=>(await pool.query(sql,[id])).rows;
  const doc={exportedAt:new Date().toISOString(),
   account:(await q("SELECT id,email,role,status,created_at,email_verified_at,signup_source,terms_version,terms_accepted_at,preferences FROM users WHERE id=$1"))[0],
   servers:await q("SELECT id,name,template_id,memory_mb,cpu_percent,disk_mb,port,created_at,created_via FROM servers WHERE owner_id=$1 AND deleted_at IS NULL"),
   subscriptions:await q("SELECT s.id,p.name AS plan,s.status,s.cycle,s.amount,s.currency,s.current_period_end,s.created_at FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1"),
   invoices:await q("SELECT number,status,amount_due,amount_paid,currency,period_start,period_end,created_at FROM invoices WHERE user_id=$1"),
   orders:await q("SELECT id,status,created_at,paid_at FROM orders WHERE user_id=$1"),
   sessions:await q("SELECT ip,user_agent,created_at,last_seen_at FROM sessions WHERE user_id=$1")};
  reply.header('content-disposition','attachment; filename="account-export.json"').header('content-type','application/json');
  return JSON.stringify(doc,null,2);
 });
}

/** Anonymises accounts whose deletion grace period is over. Invoices and orders stay, without personal data. */
export async function finishDeletions(){
 const due=(await pool.query("SELECT id,email FROM users WHERE status='deletion_pending' AND deletion_at<=now() AND role='customer' LIMIT 50")).rows;
 for(const u of due){
  const hasServers=Number((await pool.query('SELECT count(*) n FROM servers WHERE owner_id=$1 AND deleted_at IS NULL',[u.id])).rows[0].n);
  if(hasServers){await pool.query("UPDATE users SET status='active',deletion_at=NULL WHERE id=$1",[u.id]);continue;}
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   await c.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);await c.query('DELETE FROM api_tokens WHERE user_id=$1',[u.id]);await c.query('DELETE FROM passkeys WHERE user_id=$1',[u.id]);
   await c.query('DELETE FROM user_tokens WHERE user_id=$1',[u.id]);await c.query('DELETE FROM notification_channels WHERE user_id=$1',[u.id]);await c.query('DELETE FROM collaborators WHERE user_id=$1',[u.id]);
   await c.query('DELETE FROM recovery_codes WHERE user_id=$1',[u.id]);await c.query('DELETE FROM notifications WHERE user_id=$1',[u.id]);await c.query('DELETE FROM billing_customers WHERE user_id=$1',[u.id]);
   await c.query("UPDATE users SET email=$2,password_hash=$3,totp_secret=NULL,totp_pending=NULL,disabled=true,display_name=NULL,quota='{}'::jsonb,preferences='{}'::jsonb,terms_ip_hash=NULL,status='active',deletion_at=NULL WHERE id=$1",[u.id,`deleted-${u.id}@deleted.invalid`,hash(randomBytes(32).toString('hex'))]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});console.error('Account deletion failed:',(e as Error)?.message);continue;}finally{c.release();}
  await audit(null,'account.deleted','user',u.id);
  void sendTemplate('account_deleted',u.email,{}).catch(()=>{});
 }
}

export async function sweepSignup(){
 const cfg=(await settings()).signup;
 const r=await pool.query("DELETE FROM users WHERE status='pending_verification' AND created_at<now()-make_interval(days=>$1) AND NOT EXISTS(SELECT 1 FROM servers WHERE owner_id=users.id) AND NOT EXISTS(SELECT 1 FROM orders WHERE user_id=users.id) RETURNING id",[cfg.unverifiedDays]);
 if(r.rowCount)await audit(null,'signup.cleanup','user','-',{removed:r.rowCount});
 await pool.query('DELETE FROM signup_invites WHERE expires_at<now()-interval \'30 days\'');
 await finishDeletions();
}
void notifyUser;
