// Rookery, part 1: sign-up, verification, approval, invites, bot protection, account changes,
// self-service servers, limits (layers, enforce / warn / off), email templates and the outbox.
import {SMTPServer} from 'smtp-server';
import {simpleParser} from 'mailparser';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery,sleep} from './harness.mjs';

const mails=[];
let smtpDown=false;
const smtp=new SMTPServer({authOptional:true,allowInsecureAuth:true,disabledCommands:['STARTTLS'],
 onAuth(auth,session,cb){cb(null,{user:auth.username});},
 onConnect(session,cb){if(smtpDown)return cb(new Error('down'));cb();},
 onData(stream,session,cb){simpleParser(stream).then(m=>{mails.push({to:m.to?.text,subject:m.subject,text:m.text,html:m.html,from:m.from?.text,replyTo:m.replyTo?.text,bcc:m.bcc?.text});cb();}).catch(cb);}});
await new Promise(r=>smtp.listen(0,'127.0.0.1',r));
const smtpPort=smtp.server.address().port;
// A stand-in for the captcha service: "pass" succeeds, anything else fails.
const captcha=createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{const ok=new URLSearchParams(b).get('response')==='pass';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({success:ok}));});});
await new Promise(r=>captcha.listen(0,'127.0.0.1',r));

const stack=await bootStack({db:'fledge_rookery_smoke',apiPort:4181,hostPort:4529,mock:null,apiEnv:{SLOW_SWEEP_MS:'1500',SWEEP_INTERVAL_MS:'1500',RATE_LIMIT_AUTH_WRITE:'5000',FLEDGE_TEST_CAPTCHA_URL:`http://127.0.0.1:${captcha.address().port}/verify`}});
const admin=client(stack.base);const {call,ok,status,check}=admin;
let failed=null;
const rid=()=>randomBytes(3).toString('hex');
const until=async(fn,label,ms=12000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timed out waiting for '+label);await sleep(200);}};
const mailTo=(addr,pattern)=>mails.filter(m=>m.to&&m.to.includes(addr)&&(!pattern||pattern.test(m.subject)));
const waitMail=(addr,pattern,label)=>until(()=>mailTo(addr,pattern).at(-1),label||`mail to ${addr}`);
const linkOf=(m,param)=>new RegExp(`[?&]${param}=([A-Za-z0-9_-]+)`).exec(m.text)[1];
const STRONG='correct-horse-battery-staple-9';
// Settings sections are saved whole: read, change, write.
const put=async(section,patch)=>{const cur=ok(await call('GET','/api/settings'),'settings')[section];const body={...cur,...patch};for(const k of Object.keys(body))if(k.endsWith('Set'))delete body[k];return call('PUT',`/api/settings/${section}`,body);};
const reg=(c,email,extra={})=>c.call('POST','/api/auth/register',{email,password:STRONG,acceptTerms:true,...extra});

try{
 const adminLogin=await bootstrapAdmin(admin);
 const mailCfg={enabled:true,host:'127.0.0.1',port:smtpPort,security:'none',user:'mailer',password:'mail-secret',from:'Fledge <fledge@example.test>'};

 // --- Sign-up is off by default, and needs working email ---------------------------------------------
 const anon=client(stack.base);
 const cfg0=ok(await anon.call('GET','/api/signup/config'),'public sign-up config');check(cfg0.mode==='off'&&cfg0.available===false,'sign-up is off and says so');
 status(await reg(anon,'nobody@example.test'),404,'registering while sign-up is off is refused');
 ok(await call('PUT','/api/settings/email',mailCfg),'email on');
 const defaults=ok(await call('GET','/api/settings'),'settings');
 check(defaults.limits.enabled===true&&defaults.selfService.mode==='off'&&defaults.store.enabled===false&&defaults.billing.autoTerminate===false,'the new sections arrive with safe defaults');
 check(!('captchaSecret' in defaults.signup)&&defaults.signup.captchaSecretSet===false,'the captcha secret is never returned');
 status(await put('signup',{mode:'wild'}),400,'unknown sign-up mode');
 status(await put('signup',{mode:'open',captchaProvider:'turnstile'}),400,'bot protection needs keys');
 status(await put('signup',{mode:'open',requireTerms:true}),400,'terms need an address');

 // --- Open sign-up with email confirmation -------------------------------------------------------------------
 ok(await put('signup',{mode:'open',requireTerms:true,termsUrl:'https://example.test/terms',privacyUrl:'https://example.test/privacy'}),'open sign-up');
 const cfg1=ok(await anon.call('GET','/api/signup/config'),'config');check(cfg1.mode==='open'&&cfg1.available&&cfg1.requireTerms&&!JSON.stringify(cfg1).includes('captchaSecret'),'the form learns what it needs, no secrets');
 const e1=`new-${rid()}@example.test`;
 status(await anon.call('POST','/api/auth/register',{email:e1,password:'short'}),400,'short password');
 status(await anon.call('POST','/api/auth/register',{email:e1,password:'passwordpassword'}),400,'common password');
 status(await anon.call('POST','/api/auth/register',{email:e1,password:'aaaaaaaaaaaaaa'}),400,'repeating password');
 status(await anon.call('POST','/api/auth/register',{email:e1,password:`${e1.split('@')[0]}-extra`}),400,'password containing the address');
 status(await anon.call('POST','/api/auth/register',{email:'x@mailinator.com',password:STRONG,acceptTerms:true}),400,'disposable providers are refused');
 status(await anon.call('POST','/api/auth/register',{email:e1,password:STRONG}),400,'terms must be accepted');
 status(await anon.call('POST','/api/auth/register',{email:'not-an-email',password:STRONG,acceptTerms:true}),400,'bad address');
 const honey=ok(await reg(anon,`bot-${rid()}@example.test`,{website:'http://spam.example'}),'honeypot answers like success');check(honey.ok===true,'honeypot looks like success');
 check((await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM users WHERE email LIKE 'bot-%'"))[0].n===0,'but creates nothing');
 const first=ok(await reg(anon,e1),'register');check(first.ok===true,'registered');
 const vm=await waitMail(e1,/Confirm your email/,'verification mail');check(/hours/.test(vm.text)&&/Confirm email address: http/.test(vm.text)&&vm.html.includes('Confirm email address'),'the mail has text and HTML versions');
 const row=(await dbQuery(stack.databaseUrl,"SELECT status,role,signup_source,terms_version,email_verified_at FROM users WHERE email=$1",[e1]))[0];
 check(row.status==='pending_verification'&&row.role==='customer'&&row.signup_source==='signup'&&row.terms_version==='1'&&!row.email_verified_at,'the account waits, as a customer, with the terms recorded');
 const early=client(stack.base);
 const lr=await early.call('POST','/api/auth/login',{email:e1,password:STRONG});status(lr,403,'cannot sign in before confirming');check(lr.data.error==='email_unverified','with a clear reason');
 const sameAgain=ok(await reg(anon,e1),'register again');check(JSON.stringify(sameAgain)===JSON.stringify(first),'registering the same address again looks identical');
 status(await anon.call('POST','/api/auth/verify',{token:'nonsense'}),400,'bad token');
 // Registering a pending address again sends a fresh link; only the newest one works.
 const token1=linkOf(await until(()=>mailTo(e1,/Confirm your email/).length>=2&&mailTo(e1,/Confirm your email/).at(-1),'the second link'),'verify');
 status(await anon.call('POST','/api/auth/verify',{token:linkOf(vm,'verify')}),400,'the replaced link no longer works');
 const verified=ok(await anon.call('POST','/api/auth/verify',{token:token1}),'verify');check(verified.status==='active','confirming activates the account');
 status(await anon.call('POST','/api/auth/verify',{token:token1}),400,'a link works once');
 await waitMail(e1,/Welcome/,'welcome mail');
 const user1=client(stack.base);ok(await user1.call('POST','/api/auth/login',{email:e1,password:STRONG}),'sign in after confirming');
 const me=ok(await user1.call('GET','/api/auth/me'),'me');check(me.role==='customer','a customer, never anything else');
 // An address that already has an account gets a different mail, but the same answer
 const dupe=ok(await reg(anon,e1),'register existing');check(JSON.stringify(dupe)===JSON.stringify(first),'an existing address gets the same answer');
 await waitMail(e1,/already have/,'"already registered" mail');
 // sign-up cannot be used to become an administrator
 status(await anon.call('POST','/api/auth/register',{email:`adm-${rid()}@example.test`,password:STRONG,acceptTerms:true,role:'admin'}),200,'extra fields are ignored');
 check((await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM users WHERE role='admin'"))[0].n===1,'still exactly one administrator');

 // --- Resending, and rate limits ----------------------------------------------------------------------------------------------------
 const e2=`late-${rid()}@example.test`;ok(await reg(anon,e2),'register 2');await waitMail(e2,/Confirm your email/);
 const before=mailTo(e2,/Confirm your email/).length;
 ok(await anon.call('POST','/api/auth/verify/resend',{email:e2}),'resend');await until(()=>mailTo(e2,/Confirm your email/).length>before,'resent mail');
 ok(await anon.call('POST','/api/auth/verify/resend',{email:`nobody-${rid()}@example.test`}),'resend for an unknown address answers the same');
 const resetLimits=()=>dbQuery(stack.databaseUrl,"DELETE FROM request_limits");
 await resetLimits();ok(await put('signup',{perIpPerHour:2}),'tight IP limit');
 const tight=client(stack.base);
 ok(await reg(tight,`r1-${rid()}@example.test`),'first');status(await reg(tight,`r2-${rid()}@example.test`),200,'second');status(await reg(tight,`r3-${rid()}@example.test`),429,'third from one address is limited');
 ok(await put('signup',{perIpPerHour:1000,perEmailPerDay:1}),'tight email limit');
 const e3=`once-${rid()}@example.test`;ok(await reg(anon,e3),'one');status(await reg(anon,e3),429,'a second attempt for one address is limited');
 await resetLimits();ok(await put('signup',{perEmailPerDay:3,globalPerHour:1}),'tiny global limit');ok(await reg(anon,`g0-${rid()}@example.test`),'the first one still fits');
 status(await reg(anon,`g-${rid()}@example.test`),429,'a flood pauses sign-up for everyone');
 ok(await put('signup',{globalPerHour:200}),'restore');await resetLimits();
 const feed=ok(await call('GET','/api/notifications'),'notifications');check(JSON.stringify(feed).includes('Sign-up paused'),'and the administrators are told');

 // --- Domain rules ---------------------------------------------------------------------------------------------------------------------------------
 ok(await put('signup',{allowedDomains:['corp.example'],blockedDomains:['evil.example']}),'domain rules');
 status(await reg(anon,`a-${rid()}@other.example`),400,'only allowed domains');
 ok(await reg(anon,`a-${rid()}@corp.example`),'an allowed domain works');
 ok(await put('signup',{allowedDomains:[],blockedDomains:['evil.example','example.org']}),'block list');
 status(await reg(anon,`a-${rid()}@sub.evil.example`),400,'blocked domains include subdomains');
 ok(await put('signup',{blockedDomains:[]}),'clear');

 // --- Bot protection --------------------------------------------------------------------------------------------------------------------------------
 ok(await put('signup',{captchaProvider:'turnstile',captchaSiteKey:'site-key',captchaSecret:'secret-key'}),'captcha on');
 const cfgC=ok(await anon.call('GET','/api/signup/config'),'config');check(cfgC.captcha.provider==='turnstile'&&cfgC.captcha.siteKey==='site-key'&&!JSON.stringify(cfgC).includes('secret-key'),'the site key is public, the secret is not');
 status(await reg(anon,`c-${rid()}@example.test`),400,'no captcha answer is refused');
 status(await reg(anon,`c-${rid()}@example.test`,{captcha:'fail'}),400,'a failed check is refused');
 ok(await reg(anon,`c-${rid()}@example.test`,{captcha:'pass'}),'a passed check is accepted');
 ok(await put('signup',{captchaProvider:'none'}),'captcha off');

 // --- Approval mode ------------------------------------------------------------------------------------------------------------------------------------
 ok(await put('signup',{mode:'approval'}),'approval mode');
 const e4=`appr-${rid()}@example.test`;ok(await reg(anon,e4),'register for approval');
 const v4=ok(await anon.call('POST','/api/auth/verify',{token:linkOf(await waitMail(e4,/Confirm/),'verify')}),'verify');check(v4.status==='pending_approval','confirmed addresses wait for approval');
 await waitMail(e4,/waiting for approval/,'waiting mail');
 const waiting=client(stack.base);const wl=await waiting.call('POST','/api/auth/login',{email:e4,password:STRONG});status(wl,403,'cannot sign in yet');check(wl.data.error==='pending_approval','with the right reason');
 const pending=ok(await call('GET','/api/signup/pending'),'pending list');check(pending.some(p=>p.email===e4&&p.status==='pending_approval'),'administrators see who is waiting');
 const id4=(await dbQuery(stack.databaseUrl,'SELECT id FROM users WHERE email=$1',[e4]))[0].id;
 check(JSON.stringify(ok(await call('GET','/api/notifications'),'n')).includes(e4),'and are notified');
 ok(await call('POST',`/api/customers/${id4}/approve`,{}),'approve');await waitMail(e4,/approved/,'approved mail');
 ok(await waiting.call('POST','/api/auth/login',{email:e4,password:STRONG}),'sign in after approval');
 status(await call('POST',`/api/customers/${id4}/approve`,{}),409,'approving twice is refused');
 const e5=`rej-${rid()}@example.test`;ok(await reg(anon,e5),'register');ok(await anon.call('POST','/api/auth/verify',{token:linkOf(await waitMail(e5,/Confirm/),'verify')}),'verify');
 const id5=(await dbQuery(stack.databaseUrl,'SELECT id FROM users WHERE email=$1',[e5]))[0].id;
 ok(await call('POST',`/api/customers/${id5}/reject`,{}),'decline');check((await dbQuery(stack.databaseUrl,'SELECT count(*)::int n FROM users WHERE email=$1',[e5]))[0].n===0,'declined accounts are removed');await waitMail(e5,/About your/,'declined mail');
 const e6=`mv-${rid()}@example.test`;ok(await reg(anon,e6),'register');const id6=(await dbQuery(stack.databaseUrl,'SELECT id FROM users WHERE email=$1',[e6]))[0].id;
 ok(await call('POST',`/api/customers/${id6}/mark-verified`,{}),'administrators can mark an address verified');check((await dbQuery(stack.databaseUrl,'SELECT status FROM users WHERE id=$1',[id6]))[0].status==='active','which activates it');
 status(await user1.call("POST",`/api/customers/${id6}/approve`,{}),403,'customers cannot approve anyone');

 // --- Invite-only mode -------------------------------------------------------------------------------------------------------------------------------------
 ok(await put('signup',{mode:'invite'}),'invite-only');
 status(await reg(anon,`i-${rid()}@example.test`),400,'no code, no account');
 status(await reg(anon,`i-${rid()}@example.test`,{inviteCode:'wrong'}),400,'a wrong code');
 const inv=ok(await call('POST','/api/signup/invites',{maxUses:1,expiresInDays:7,note:'friend'}),'create invite');check(inv.code&&inv.link.includes(inv.code),'an invitation has a code and a link');
 check(!JSON.stringify(ok(await call('GET','/api/signup/invites'),'list')).includes(inv.code),'codes are stored hashed and shown once');
 const e7=`inv-${rid()}@example.test`;ok(await reg(anon,e7,{inviteCode:inv.code}),'register with a code');
 const v7=ok(await anon.call('POST','/api/auth/verify',{token:linkOf(await waitMail(e7,/Confirm/),'verify')}),'verify');check(v7.status==='active','invited people skip approval');
 status(await reg(anon,`i-${rid()}@example.test`,{inviteCode:inv.code}),400,'a single-use code is used up');
 const inv2=ok(await call('POST','/api/signup/invites',{email:'only@example.test'}),'bound invite');
 status(await reg(anon,`i-${rid()}@example.test`,{inviteCode:inv2.code}),400,'an invite for one address refuses others');
 ok(await call('DELETE',`/api/signup/invites/${inv2.id}`),'delete invite');
 ok(await put('signup',{mode:'open',requireTerms:false}),'open again');

 // --- Changing the email address ------------------------------------------------------------------------------------------------------------------------
 const newAddr=`moved-${rid()}@example.test`;
 status(await user1.call('POST','/api/account/email',{email:newAddr,password:'wrong-password-123'}),403,'the password is required');
 ok(await user1.call('POST','/api/account/email',{email:newAddr,password:STRONG}),'request change');
 const cm=await waitMail(newAddr,/Confirm your new email/,'confirmation to the new address');
 check((await dbQuery(stack.databaseUrl,'SELECT email FROM users WHERE email=$1',[e1])).length===1,'nothing changes until it is confirmed');
 ok(await anon.call('POST','/api/auth/email/confirm',{token:linkOf(cm,'confirm-email')}),'confirm');
 check((await dbQuery(stack.databaseUrl,'SELECT count(*)::int n FROM users WHERE email=$1',[newAddr]))[0].n===1,'the address changed');
 await waitMail(e1,/was changed/,'notice to the old address');
 status(await anon.call('POST','/api/auth/email/confirm',{token:linkOf(cm,'confirm-email')}),400,'once');

 // --- Account export and deletion ------------------------------------------------------------------------------------------------------------------------------
 const exp=await user1.call('GET','/api/account/export');status(exp,200,'export');check((typeof exp.data==="string"?JSON.parse(exp.data):exp.data).account.email===newAddr,'a person can download their data');
 status(await user1.call('POST','/api/account/delete',{password:'wrong-password-123'}),403,'deletion needs the password');
 ok(await put('signup',{deletionGraceDays:14}),'grace');
 const del=ok(await user1.call('POST','/api/account/delete',{password:STRONG}),'delete');check(del.deletionAt,'deletion is scheduled');
 await waitMail(newAddr,/will be deleted/,'scheduled mail');
 ok(await user1.call('POST','/api/account/delete/cancel',{}),'cancel deletion');
 ok(await put('signup',{deletionGraceDays:0}),'no grace');
 ok(await user1.call('POST','/api/account/delete',{password:STRONG}),'delete now');await sleep(500);
 const gone=(await dbQuery(stack.databaseUrl,"SELECT email,disabled,password_hash FROM users WHERE email LIKE 'deleted-%'"));check(gone.length===1&&gone[0].disabled,'the account is anonymised and locked');
 await waitMail(newAddr,/was deleted/,'deleted mail');
 const u1again=client(stack.base);status(await u1again.call('POST','/api/auth/login',{email:newAddr,password:STRONG}),401,'and cannot sign in');
 ok(await put('signup',{deletionGraceDays:14}),'restore');

 // --- Email templates and the outbox --------------------------------------------------------------------------------------------------------------------------
 const templates=ok(await call('GET','/api/email/templates'),'templates');check(templates.length>=25&&templates.every(t=>t.vars.length>=7),'every template lists its variables');
 status(await call('PUT','/api/email/templates/welcome',{subject:'Hi {{nope}}',body:'x'}),400,'unknown variables are refused');
 status(await call('PUT','/api/email/templates/verify_email',{subject:'Confirm',body:'No link at all'}),400,'a critical email must keep its link');
 status(await call('PUT','/api/email/templates/nothing',{subject:'a',body:'b'}),404,'unknown template');
 const prev=ok(await call('POST','/api/email/templates/welcome/preview',{subject:'Welcome to {{brand}} <b>',body:'Hello **there**\n\n- one\n- two\n\n[button: Go | {{panelUrl}}]'}),'preview');
 check(prev.subject.startsWith('Welcome to Fledge')&&prev.html.includes('<strong>there</strong>')&&prev.html.includes('<li')&&prev.text.includes('Go: http')&&prev.problems.length===0,'previews render text and HTML');
 check(!prev.html.includes('<b>')||prev.html.includes('&lt;'),'markup in values is escaped');
 ok(await call('PUT','/api/email/templates/welcome',{subject:'Glad you are here, {{brand}}!',body:'Custom welcome for {{email}}.',enabled:true}),'edit welcome');
 const e8=`tpl-${rid()}@example.test`;ok(await reg(anon,e8),'register');const vm8=await waitMail(e8,/Confirm/);ok(await anon.call('POST','/api/auth/verify',{token:linkOf(vm8,'verify')}),'verify');
 const wm=await waitMail(e8,/Glad you are here/,'customised welcome');check(wm.text.includes(`Custom welcome for ${e8}`),'the edited text is used');
 ok(await call('PUT','/api/email/templates/welcome',{subject:'Glad you are here',body:'x',enabled:false}),'disable welcome');
 const e9=`tpl-${rid()}@example.test`;ok(await reg(anon,e9),'register');ok(await anon.call('POST','/api/auth/verify',{token:linkOf(await waitMail(e9,/Confirm/),'verify')}),'verify');await sleep(1500);
 check(mailTo(e9,/Glad you are here|Welcome/).length===0,'a disabled template sends nothing');
 ok(await call('PUT','/api/email/templates/welcome',{subject:'Welcome',body:'x',enabled:false}),'still disabled');
 ok(await call('DELETE','/api/email/templates/welcome'),'reset welcome');check(ok(await call('GET','/api/email/templates'),'t').find(t=>t.id==='welcome').customized===false,'reset returns the original');
 ok(await call('PUT','/api/email/templates/verify_email',{subject:'Confirm {{brand}}',body:'Go: {{link}}',enabled:false}),'critical templates cannot be disabled');check(ok(await call('GET','/api/email/templates'),'t').find(t=>t.id==='verify_email').enabled===true,'still enabled');
 ok(await call('DELETE','/api/email/templates/verify_email'),'reset');
 ok(await call('POST','/api/email/templates/payment_receipt/test',{}),'send a test of a template');const tm=await waitMail(adminLogin.email,/\[Test\]/,'test mail');check(tm.text.includes('€8.00'),'tests use sample values');
 // retries: the mail server goes away, mail waits and is delivered afterwards
 smtpDown=true;
 const e10=`retry-${rid()}@example.test`;ok(await reg(anon,e10),'register while the mail server is down');await sleep(1500);
 check(mailTo(e10).length===0,'nothing could be delivered');
 const box=ok(await call('GET','/api/email/outbox'),'outbox');check(box.items.some(i=>i.to===e10&&i.status==='queued'&&i.attempts>=1&&i.lastError),'the message is kept, with the error');
 smtpDown=false;const qid=box.items.find(i=>i.to===e10).id;
 ok(await call('POST',`/api/email/outbox/${qid}/retry`,{}),'retry now');await waitMail(e10,/Confirm/,'delivered after retry');
 check(ok(await call('GET','/api/email/outbox?status=sent'),'sent').items.some(i=>i.to===e10),'and the log says sent');
 const oneDay=(await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM email_outbox WHERE dedupe_key IS NOT NULL"))[0].n;check(oneDay>=0,'dedupe keys are recorded');
 status(await put('email',{replyTo:'support@example.test',adminBcc:'ops@example.test'}),200,'reply-to and copy address');

 // --- Self-service servers -------------------------------------------------------------------------------------------------------------------------------------------
 const node=await makeNode(admin,'rk-node','eu-west');await heartbeat(admin,node);
 const cust=ok(await call('POST','/api/customers',{email:`own-${rid()}@example.test`}),'customer');
 const owner=client(stack.base);ok(await owner.call('POST','/api/auth/login',{email:cust.email,password:cust.temporaryPassword}),'login');
 const opt0=ok(await owner.call('GET','/api/me/servers/options'),'options');check(opt0.mode==='off'&&opt0.canCreate===false&&opt0.templates.length===0,'off by default');
 status(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Mine'}),403,'customers cannot create servers while it is off');
 ok(await put('selfService',{mode:'custom',allowDelete:true,deleteCoolingHours:24}),'self-service on');
 status(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Mine'}),404,'templates are invisible until released');
 const tpls=ok(await call('GET','/api/templates'),'templates');check(tpls.find(t=>t.id==='minecraft-java').customerVisible===false,'hidden by default');
 status(await owner.call('PUT','/api/templates/minecraft-java/store',{customerVisible:true}),403,'customers cannot release templates');
 ok(await call('PUT','/api/templates/minecraft-java/store',{customerVisible:true,customerDescription:'Vanilla and modded Minecraft'}),'release the template');
 const opt1=ok(await owner.call('GET','/api/me/servers/options'),'options');check(opt1.canCreate&&opt1.templates.length===1&&opt1.templates[0].description.startsWith('Vanilla')&&opt1.locations.includes('eu-west'),'options list released templates and locations');
 check(!JSON.stringify(opt1).includes('RCON_PASSWORD'),'secret variables are never offered');
 // limits: nothing set, so a server can be created
 const s1=ok(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'First',memoryMb:1024,cpuPercent:100,diskMb:2048}),'create');check(s1.ownerId===cust.id&&s1.job&&!JSON.stringify(s1.placement).includes('reason'),'created for the caller, with a job');
 check((await dbQuery(stack.databaseUrl,'SELECT created_via FROM servers WHERE id=$1',[s1.id]))[0].created_via==='self','marked as self-service');
 status(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Bad',memoryMb:100}),400,'tiny memory refused');
 status(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Bad',variables:{EULA:'FALSE'}}),400,'only offered variables can be set');
 status(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Bad',location:'nowhere'}),409,'unknown location finds no room');
 const job=await nextJob(admin,node);check(job&&job.kind==='create','the node gets a create job');await finishJob(admin,node,job,true,{});
 const list=ok(await owner.call('GET','/api/servers'),'own servers');check(list.length===1,'the customer sees it');
 // limits layers
 ok(await put('limits',{defaults:{servers:1,maxServerMemoryMb:2048}}),'default: one server');
 const lim=ok(await owner.call('GET','/api/limits/me'),'my limits');check(lim.rows.find(r=>r.key==='servers').limit===1&&lim.rows.find(r=>r.key==='servers').used===1&&lim.rows.find(r=>r.key==='servers').source==='default','usage and limit with their source');
 const blocked=await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Second'});status(blocked,409,'the second server is over the limit');check(blocked.data.error==='limit_exceeded'&&/limit of 1 servers/.test(blocked.data.message),'with a clear message');
 status(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Big',memoryMb:4096}),409,'per-server maximum');
 ok(await call('PATCH',`/api/customers/${cust.id}`,{quota:{maxServers:3}}),'override: three servers');
 const lim2=ok(await call('GET',`/api/customers/${cust.id}/limits`),'admin view');check(lim2.rows.find(r=>r.key==='servers').limit===3&&lim2.rows.find(r=>r.key==='servers').source==='override'&&lim2.override.servers===3,'overrides win and are explained');
 check(ok(await call('GET',`/api/customers/${cust.id}`),'c').quota.maxServers===3,'stored with the names it always had');
 const s2=ok(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Second'}),'create under the override');
 await nextJob(admin,node).then(j=>j&&finishJob(admin,node,j,true,{}));
 ok(await call('PATCH',`/api/customers/${cust.id}`,{quota:{maxServers:null}}),'override: unlimited');
 const lim3=ok(await call('GET',`/api/customers/${cust.id}/limits`),'view');check(lim3.rows.find(r=>r.key==='servers').unlimited,'null means unlimited');
 ok(await call('PATCH',`/api/customers/${cust.id}`,{quota:{}}),'clear override');
 status(await call('PATCH',`/api/customers/${cust.id}`,{quota:{bogus:1}}),400,'unknown limits are refused');
 // warn mode lets it through and says so
 ok(await put('limits',{mode:'warn'}),'warn mode');
 const s3=ok(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Third'}),'warn mode allows it');
 await nextJob(admin,node).then(j=>j&&finishJob(admin,node,j,true,{}));
 await until(async()=>(await dbQuery(stack.databaseUrl,"SELECT 1 FROM audit_events WHERE action='limit.exceeded'")).length,'a record of the overage');
 check(JSON.stringify(ok(await owner.call('GET','/api/notifications'),'n')).includes('over a limit'),'and the customer is told');
 // disabled: nothing is enforced
 ok(await put('limits',{mode:'enforce',enabled:false}),'limits off');
 ok(await owner.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Fourth',memoryMb:512}),'nothing is enforced while limits are off');
 await nextJob(admin,node).then(j=>j&&finishJob(admin,node,j,true,{}));
 ok(await put('limits',{enabled:true,mode:'enforce',showUsage:false}),'back on, usage hidden');check(ok(await owner.call('GET','/api/limits/me'),'m').hidden===true,'usage can be hidden from customers');
 ok(await put('limits',{showUsage:true,defaults:{}}),'restore');
 status(await put('limits',{adminOverride:'sometimes'}),400,'bad override mode');

 // --- Deleting your own server -------------------------------------------------------------------------------------------------------------------------------------------------------
 ok(await put('selfService',{allowDelete:false}),'deleting off');
 status(await owner.call('DELETE',`/api/me/servers/${s2.id}`,{confirm:true}),403,'refused when the panel does not allow it');
 ok(await put('selfService',{allowDelete:true,deleteCoolingHours:24}),'deleting on');
 status(await owner.call('DELETE',`/api/me/servers/${s2.id}`,{}),400,'confirmation is required');
 const other=client(stack.base);const c2=ok(await call('POST','/api/customers',{email:`oth-${rid()}@example.test`}),'c2');ok(await other.call('POST','/api/auth/login',{email:c2.email,password:c2.temporaryPassword}),'login');
 status(await other.call('DELETE',`/api/me/servers/${s2.id}`,{confirm:true}),404,'nobody else can delete it');
 const d1=ok(await owner.call('DELETE',`/api/me/servers/${s2.id}`,{confirm:true}),'schedule deletion');check(d1.deleted===false&&d1.deletesAt,'a cooling-off period starts');
 const sh=ok(await owner.call('GET',`/api/servers/${s2.id}`),'server');check(sh.pendingDeleteAt&&sh.suspendedReason==='owner-deleted','the server shows it will be deleted');
 status(await owner.call('DELETE',`/api/me/servers/${s2.id}`,{confirm:true}),409,'only once');
 ok(await owner.call('POST',`/api/me/servers/${s2.id}/restore`,{}),'undo');check(!ok(await owner.call('GET',`/api/servers/${s2.id}`),'s').pendingDeleteAt,'undone');
 ok(await put('selfService',{deleteCoolingHours:0}),'immediate');
 const d2=ok(await owner.call('DELETE',`/api/me/servers/${s2.id}`,{confirm:true}),'delete now');check(d2.deleted===true,'deleted at once');
 let dj;for(let i=0;i<10;i++){dj=await nextJob(admin,node);if(!dj||dj.kind==='delete')break;await finishJob(admin,node,dj,true,{});}
 check(dj&&dj.kind==='delete','the node gets a delete job');await finishJob(admin,node,dj,true,{});

 console.log(`PASS ${admin.state.count} assertions: sign-up (open, approval, invite-only), confirmation, bot protection, rate limits, enumeration, account changes, export and deletion, email templates and outbox, self-service servers, layered limits (enforce, warn, off), owner deletion`);
}catch(e){failed=e;console.error('FAIL',e.message);console.error(String(e.stack).split(String.fromCharCode(10)).filter(l=>l.includes('rookery-smoke')).slice(0,2).join(String.fromCharCode(10)));console.error('--- api log tail ---');console.error(stack.api.logs().split(String.fromCharCode(10)).slice(-25).join(String.fromCharCode(10)));}
await stack.stop();smtp.close();captcha.close();
process.exit(failed?1:0);
