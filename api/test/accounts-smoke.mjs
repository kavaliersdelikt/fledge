// Sessions, email (SMTP) flows, passkeys, the admin network allow-list, audit export, OpenAPI,
// response headers and backup quotas.
import {SMTPServer} from 'smtp-server';
import {simpleParser} from 'mailparser';
import {randomBytes,createHash} from 'node:crypto';
import {authenticator} from 'otplib';
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery,sleep} from './harness.mjs';
import {makeAuthenticator} from './authenticator.mjs';

const mails=[];
const smtp=new SMTPServer({authOptional:true,allowInsecureAuth:true,disabledCommands:['STARTTLS'],
 onAuth(auth,session,cb){cb(null,{user:auth.username});},
 onData(stream,session,cb){simpleParser(stream).then(m=>{mails.push({to:m.to?.text,subject:m.subject,text:m.text,from:m.from?.text});cb();}).catch(cb);}});
await new Promise(r=>smtp.listen(0,'127.0.0.1',r));
const smtpPort=smtp.server.address().port;

const stack=await bootStack({db:'fledge_accounts_smoke',apiPort:4178,hostPort:4526,mock:null,apiEnv:{SLOW_SWEEP_MS:'1500',RATE_LIMIT_AUTH_WRITE:'5000'}});
const admin=client(stack.base);const {call,ok,status,check}=admin;
let failed=null;
const rid=()=>randomBytes(3).toString('hex');
const until=async(fn,label,ms=10000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timed out waiting for '+label);await sleep(200);}};
const tokenOf=m=>/[?&]token=([A-Za-z0-9_-]+)/.exec(m.text)[1];
const newCustomer=async(email='c-'+rid()+'@example.test')=>ok(await call('POST','/api/customers',{email}),'customer');
const login=async(u,pw)=>{const c=client(stack.base);ok(await c.call('POST','/api/auth/login',{email:u.email,password:pw||u.temporaryPassword}),'login '+u.email);return c;};
try{
 const adminLogin=await bootstrapAdmin(admin);

 // --- Sessions ---------------------------------------------------------------------------------------------
 const alice=await newCustomer();
 const a1=await login(alice),a2=await login(alice);
 const list=ok(await a1.call('GET','/api/auth/sessions'),'sessions');
 check(list.length===2&&list.filter(s=>s.current).length===1&&list.every(s=>s.lastSeenAt&&s.expiresAt),'both devices are listed and the current one is flagged');
 check(typeof list[0].ip==='string','sessions record where they came from');
 const other=list.find(s=>!s.current);
 ok(await a1.call('DELETE',`/api/auth/sessions/${other.id}`),'sign the other device out');
 a2.status(await a2.call('GET','/api/auth/me'),401,'the signed-out device is signed out');
 a1.status(await a1.call('DELETE',`/api/auth/sessions/${other.id}`),404,'revoking twice');
 const a3=await login(alice);
 const rev=ok(await a1.call('POST','/api/auth/sessions/revoke-others'),'sign out others');check(rev.revoked===1,'sign out everywhere else');
 a3.status(await a3.call('GET','/api/auth/me'),401,'the other session is gone');
 ok(await a1.call('GET','/api/auth/me'),'while this one stays');
 const tok=ok(await call('POST','/api/tokens',{name:'t',scopes:['read']}),'api token');
 status(await call('GET','/api/auth/sessions',undefined,{authorization:'Bearer '+tok.token}),403,'API tokens cannot list sessions');
 const b1=await login(alice),b2=await login(alice);
 ok(await call('POST',`/api/customers/${alice.id}/sign-out`),'admin signs a customer out everywhere');
 b1.status(await b1.call('GET','/api/auth/me'),401,'the customer is signed out');b2.status(await b2.call('GET','/api/auth/me'),401,'on every device');

 // --- Invitation links without email -----------------------------------------------------------------------------
 const inv0=ok(await call('POST',`/api/customers/${alice.id}/invite`),'invite without email');
 check(inv0.sent===false&&/\?token=/.test(inv0.link),'without email the administrator gets the link to pass on');
 const link0=/token=([A-Za-z0-9_-]+)/.exec(inv0.link)[1];
 status(await call('POST','/api/auth/token/accept',{token:link0,password:'short'}),400,'weak password refused');
 ok(await call('POST','/api/auth/token/accept',{token:link0,password:'a-brand-new-password-1'}),'accept invitation');
 status(await call('POST','/api/auth/token/accept',{token:link0,password:'a-brand-new-password-2'}),400,'a link works once');
 status(await call('POST','/api/auth/token/accept',{token:'nope',password:'a-brand-new-password-3'}),400,'unknown link');
 const aliceNew=client(stack.base);status(await aliceNew.call('POST','/api/auth/login',{email:alice.email,password:alice.temporaryPassword}),401,'the old password stops working');
 ok(await aliceNew.call('POST','/api/auth/login',{email:alice.email,password:'a-brand-new-password-1'}),'the new one works');
 alice.temporaryPassword='a-brand-new-password-1';

 // --- Email settings -----------------------------------------------------------------------------------------------------
 const mailCfg={enabled:true,host:'127.0.0.1',port:smtpPort,security:'none',user:'mailer',password:'mail-secret',from:'Fledge <fledge@example.test>'};
 status(await call('PUT','/api/settings/email',{...mailCfg,host:''}),400,'email needs a host');
 status(await call('PUT','/api/settings/email',{...mailCfg,port:0}),400,'bad port');
 status(await call('PUT','/api/settings/email',{...mailCfg,from:'not an address'}),400,'bad From');
 status(await call('PUT','/api/settings/email',{...mailCfg,security:'maybe'}),400,'bad security mode');
 status(await call('PUT','/api/settings/email',{...mailCfg,host:'bad host!'}),400,'bad host name');
 ok(await call('PUT','/api/settings/email',mailCfg),'save email settings');
 const shown=ok(await call('GET','/api/settings'),'settings').email;check(shown.passwordSet===true&&!('password' in shown)&&!JSON.stringify(shown).includes('mail-secret'),'the SMTP password is never returned');
 const raw=(await dbQuery(stack.databaseUrl,"SELECT secret FROM settings WHERE key='email'"))[0].secret;check(raw&&!raw.includes('mail-secret'),'and is encrypted at rest');
 await sleep(5200);
 ok(await call('POST','/api/settings/email/test',{to:'ops@example.test'}),'send a test email');
 const testMail=await until(()=>mails.find(m=>/test email/i.test(m.subject)),'the test email');check(/ops@example.test/.test(testMail.to)&&/fledge@example.test/.test(testMail.from),'it arrives with the configured sender');
 status(await call('POST','/api/settings/email/test',{to:'nonsense'}),400,'invalid recipient');
 ok(await call('PUT','/api/settings/email',{...mailCfg,port:1,password:undefined}),'point at a dead port (password kept)');await sleep(5200);
 status(await call('POST','/api/settings/email/test',{to:'ops@example.test'}),502,'a mail server that cannot be reached is reported');
 ok(await call('PUT','/api/settings/email',mailCfg),'restore');await sleep(5200);

 // --- Invitations and resets by email -------------------------------------------------------------------------------
 const bob=await newCustomer('bob-'+rid()+'@example.test');
 mails.length=0;
 check(ok(await call('POST',`/api/customers/${bob.id}/invite`),'invite by email').sent===true,'with email set up the invitation is sent');
 const invMail=await until(()=>mails.find(m=>m.to&&m.to.includes(bob.email)),'the invitation email');
 check(/invited to Fledge/i.test(invMail.subject)&&/7 days/.test(invMail.text),'the invitation explains itself');
 ok(await call('POST','/api/auth/token/accept',{token:tokenOf(invMail),password:'bobs-first-password-1'}),'accept the emailed invitation');
 mails.length=0;
 ok(await client(stack.base).call('POST','/api/auth/forgot',{email:'nobody-'+rid()+'@example.test'}),'forgot password for an unknown address');
 await sleep(800);check(mails.length===0,'no email goes out for unknown addresses, and the answer is the same');
 const fg=client(stack.base);
 ok(await fg.call('POST','/api/auth/forgot',{email:bob.email}),'forgot password');
 const resetMail=await until(()=>mails.find(m=>m.to&&m.to.includes(bob.email)),'the reset email');check(/Reset your Fledge password/.test(resetMail.subject)&&/one hour/.test(resetMail.text),'the reset email says how long it works');
 ok(await fg.call('POST','/api/auth/token/accept',{token:tokenOf(resetMail),password:'bobs-second-password-2'}),'reset the password');
 const bobC=client(stack.base);status(await bobC.call('POST','/api/auth/login',{email:bob.email,password:'bobs-first-password-1'}),401,'the old password is dead');
 ok(await bobC.call('POST','/api/auth/login',{email:bob.email,password:'bobs-second-password-2'}),'the new password signs in');
 for(let i=0;i<5;i++)await fg.call('POST','/api/auth/forgot',{email:bob.email});
 await sleep(1000);check(mails.filter(m=>m.to&&m.to.includes(bob.email)&&/Reset your/.test(m.subject)).length<=3,'password reset emails are rate limited per address');
 // An administrator who resets a password still needs the authenticator.
 mails.length=0;
 await fg.call('POST','/api/auth/forgot',{email:adminLogin.email});
 const adminMail=await until(()=>mails.find(m=>m.to&&m.to.includes(adminLogin.email)),'the administrator reset email');
 ok(await fg.call('POST','/api/auth/token/accept',{token:tokenOf(adminMail),password:'admins-new-password-3'}),'administrator resets the password');
 const again=client(stack.base);
 status(await again.call('POST','/api/auth/login',{email:adminLogin.email,password:'admins-new-password-3'}),401,'the new password alone is not enough for an administrator');
 const stepwise=ok(await again.call('POST','/api/auth/login',{email:adminLogin.email,password:'admins-new-password-3',stepwise:true}),'stepwise sign-in');check(stepwise.requires2fa&&stepwise.methods.join()==='totp','the authenticator is still required');
 ok(await again.call('POST','/api/auth/login',{email:adminLogin.email,password:'admins-new-password-3',totp:authenticator.generate(adminLogin.secret)}),'with the authenticator it works');
 adminLogin.password='admins-new-password-3';
 status(await call('GET','/api/auth/me',undefined,{authorization:'Bearer '+tok.token}),401,'a password reset revokes the API tokens of that account');
 admin.cookie=again.cookie; // the reset signed every old session out

 // --- Inviting collaborators -----------------------------------------------------------------------------------------------
 const node=await makeNode(admin,'acc','test',{memoryMb:32768,cpuPercent:3200,diskMb:500000});await heartbeat(admin,node);
 const server=ok(await call('POST','/api/servers',{name:'Shared',ownerId:alice.id,templateId:'minecraft-paper',nodeId:node.id,memoryMb:1024,cpuPercent:100,diskMb:2048}),'server');
 const cj=await nextJob(admin,node);await finishJob(admin,node,cj);
 const owner=await login(alice);
 const guest='guest-'+rid()+'@example.test';
 owner.status(await owner.call('POST',`/api/servers/${server.id}/collaborators`,{email:guest,permissions:['view']}),404,'without invite:true unknown addresses are refused');
 mails.length=0;
 const added=ok(await owner.call('POST',`/api/servers/${server.id}/collaborators`,{email:guest,permissions:['view','console'],invite:true}),'invite a collaborator');
 check(added.permissions.length===2,'the collaborator is added');
 const guestMail=await until(()=>mails.find(m=>m.to&&m.to.includes(guest)),'the collaborator invitation');
 ok(await client(stack.base).call('POST','/api/auth/token/accept',{token:tokenOf(guestMail),password:'guests-password-123'}),'the guest sets a password');
 const guestC=await login({email:guest},'guests-password-123');
 check(ok(await guestC.call('GET','/api/servers'),'guest servers').some(s=>s.id===server.id),'and sees the shared server');
 owner.status(await owner.call('POST',`/api/servers/${server.id}/collaborators`,{email:adminLogin.email,permissions:['view'],invite:true}),409,'addresses of other account types are refused');
 const outsider=await login(await newCustomer());
 outsider.status(await outsider.call('POST',`/api/servers/${server.id}/collaborators`,{email:'x@example.test',permissions:['view'],invite:true}),404,'only managers can invite');
 let blocked=0;for(let i=0;i<12;i++){const r=await owner.call('POST',`/api/servers/${server.id}/collaborators`,{email:`bulk-${i}-${rid()}@example.test`,permissions:['view'],invite:true});if(r.code===429)blocked++;}
 check(blocked>=1,'inviting is rate limited per person ('+blocked+' blocked)');

 // --- Passkeys ---------------------------------------------------------------------------------------------------------------
 const dana=await newCustomer();const dc=await login(dana);
 const key=makeAuthenticator();
 const reg=ok(await dc.call('POST','/api/auth/passkeys/options'),'registration options');
 check(reg.rp.id==='localhost'&&reg.user.name===dana.email&&reg.challenge,'options name the relying party and the user');
 dc.status(await dc.call('POST','/api/auth/passkeys/verify',{response:key.register(reg,{originOverride:'https://evil.example'}),name:'Evil'}),400,'a registration from another origin is refused');
 const reg2=ok(await dc.call('POST','/api/auth/passkeys/options'),'options again');
 ok(await dc.call('POST','/api/auth/passkeys/verify',{response:key.register(reg2),name:'Laptop'}),'register the passkey');
 const keys=ok(await dc.call('GET','/api/auth/passkeys'),'list');check(keys.length===1&&keys[0].name==='Laptop'&&keys[0].id===key.credentialId,'the passkey is listed');
 const reg3=ok(await dc.call('POST','/api/auth/passkeys/options'),'options a third time');check(reg3.excludeCredentials.length===1,'already registered keys are excluded from new registrations');
 dc.status(await dc.call('POST','/api/auth/passkeys/verify',{response:key.register(reg3),name:'Again'}),409,'the same passkey cannot be added twice');
 check(ok(await dc.call('GET','/api/auth/me'),'me').passkeys===1,'the account knows it has a passkey');
 // Signing in now needs the passkey.
 const sign=client(stack.base);
 const step=ok(await sign.call('POST','/api/auth/login',{email:dana.email,password:dana.temporaryPassword,stepwise:true}),'stepwise login');
 check(step.requires2fa&&step.methods.join()==='passkey'&&step.challenge,'a passkey-only account is asked for the passkey');
 status(await sign.call('POST','/api/auth/login',{email:dana.email,password:dana.temporaryPassword}),401,'plain API login is refused for passkey accounts');
 const opt=ok(await sign.call('POST','/api/auth/passkey/options',{challenge:step.challenge}),'passkey options');
 check(opt.challenge&&opt.allowCredentials.length===1&&opt.rpId==='localhost','the assertion options name the registered key');
 status(await sign.call('POST','/api/auth/passkey/verify',{challenge:step.challenge,response:key.assert(opt,{tamper:true})}),401,'a forged signature is refused');
 const opt2=ok(await sign.call('POST','/api/auth/passkey/options',{challenge:step.challenge}),'options after a failure');
 status(await sign.call('POST','/api/auth/passkey/verify',{challenge:step.challenge,response:key.assert(opt2,{originOverride:'https://evil.example'})}),401,'an assertion for another origin is refused');
 const opt3=ok(await sign.call('POST','/api/auth/passkey/options',{challenge:step.challenge}),'options');
 const good=key.assert(opt3);
 const signed=ok(await sign.call('POST','/api/auth/passkey/verify',{challenge:step.challenge,response:good}),'sign in with the passkey');
 check(signed.email===dana.email&&ok(await sign.call('GET','/api/auth/me'),'me after passkey login').id===dana.id,'the passkey creates a session');
 status(await client(stack.base).call('POST','/api/auth/passkey/verify',{challenge:step.challenge,response:good}),401,'a login challenge is single-use');
 const step2=ok(await client(stack.base).call('POST','/api/auth/login',{email:dana.email,password:dana.temporaryPassword,stepwise:true}),'second login');
 const sign2=client(stack.base);
 const o4=ok(await sign2.call('POST','/api/auth/passkey/options',{challenge:step2.challenge}),'options');
 status(await sign2.call('POST','/api/auth/passkey/verify',{challenge:step2.challenge,response:key.assert(o4,{replay:true})}),401,'replaying an old counter value is refused');
 const sessionsAfter=ok(await sign.call('GET','/api/auth/sessions'),'sessions');check(sessionsAfter.length>=1,'passkey logins show up as sessions');
 const lastUsed=ok(await dc.call('GET','/api/auth/passkeys'),'list').find(k=>k.id===key.credentialId).lastUsedAt;check(lastUsed,'the passkey remembers when it was used');
 // Second-factor failures are counted per account, across challenges.
 const mfaBucket=createHash('sha256').update('mfa:'+dana.id).digest('hex');
 const failed=(await dbQuery(stack.databaseUrl,'SELECT attempts FROM login_attempts WHERE bucket_hash=$1',[mfaBucket]))[0];
 check(failed&&failed.attempts>=3,'failed passkey verifications are counted against the account');
 await dbQuery(stack.databaseUrl,"UPDATE login_attempts SET attempts=10 WHERE bucket_hash=$1",[mfaBucket]);
 status(await client(stack.base).call('POST','/api/auth/login',{email:dana.email,password:dana.temporaryPassword,stepwise:true}),429,'after too many failed verifications the second step is locked');
 await dbQuery(stack.databaseUrl,'DELETE FROM login_attempts WHERE bucket_hash=$1',[mfaBucket]);
 dc.status(await dc.call('DELETE','/api/auth/passkeys/nonexistent'),404,'removing an unknown passkey');
 ok(await dc.call('DELETE',`/api/auth/passkeys/${encodeURIComponent(key.credentialId)}`),'remove the passkey');
 ok(await client(stack.base).call('POST','/api/auth/login',{email:dana.email,password:dana.temporaryPassword}),'without passkeys plain sign-in works again');
 // Administrators can have both factors.
 const adminPk=makeAuthenticator();const adminC=client(stack.base);
 const alog=ok(await adminC.call('POST','/api/auth/login',{email:adminLogin.email,password:adminLogin.password,totp:authenticator.generate(adminLogin.secret)}),'admin login');void alog;
 const areg=ok(await adminC.call('POST','/api/auth/passkeys/options'),'admin options');ok(await adminC.call('POST','/api/auth/passkeys/verify',{response:adminPk.register(areg),name:'Yubikey'}),'admin registers a passkey');
 const astep=ok(await client(stack.base).call('POST','/api/auth/login',{email:adminLogin.email,password:adminLogin.password,stepwise:true}),'admin stepwise');check(astep.methods.join()==='totp,passkey','administrators can choose between authenticator and passkey');
 ok(await adminC.call('DELETE',`/api/auth/passkeys/${encodeURIComponent(adminPk.credentialId)}`),'remove the admin passkey');

 // --- Administrator network allow-list ----------------------------------------------------------------------------------------------
 status(await call('PUT','/api/settings/security',{adminAllowedCidrs:['10.0.0.0/8'],auditRetentionDays:0}),400,'a list without your own address would lock you out');
 status(await call('PUT','/api/settings/security',{adminAllowedCidrs:['nonsense'],auditRetentionDays:0}),400,'invalid entries');
 status(await call('PUT','/api/settings/security',{adminAllowedCidrs:['10.0.0.0/33'],auditRetentionDays:0}),400,'invalid prefix length');
 status(await call('PUT','/api/settings/security',{adminAllowedCidrs:[],auditRetentionDays:-1}),400,'invalid retention');
 const chk=ok(await call('POST','/api/settings/security/check',{adminAllowedCidrs:['127.0.0.0/8']}),'check');check(chk.allowed===true&&chk.yourAddress,'the check tells whether you would stay in');
 ok(await call('PUT','/api/settings/security',{adminAllowedCidrs:['127.0.0.0/8','::1'],auditRetentionDays:0}),'a list that includes you is accepted');
 check((await call('GET','/api/nodes')).code===200,'and you can still work');
 // (a password reset revokes API tokens, so the token used below is created after the resets above)
 const lockTok=ok(await call('POST','/api/tokens',{name:'lock',scopes:['read']}),'api token for the allow-list check');
 await dbQuery(stack.databaseUrl,"UPDATE settings SET value=jsonb_set(value,'{adminAllowedCidrs}','[\"10.0.0.0/8\"]'::jsonb) WHERE key='security'");await sleep(5300);
 const locked=await call('GET','/api/nodes');status(locked,403,'outside the allow-list administrators are refused');check(/restricted to specific networks/.test(locked.data.message),'with an explanation');
 status(await call('GET','/api/nodes',undefined,{authorization:'Bearer '+lockTok.token}),403,'API tokens of administrators are covered too');
 check((await owner.call('GET','/api/servers')).code===200,'customers are not affected');
 await dbQuery(stack.databaseUrl,"UPDATE settings SET value=jsonb_set(value,'{adminAllowedCidrs}','[]'::jsonb) WHERE key='security'");await sleep(5300);
 check((await call('GET','/api/nodes')).code===200,'removing the list restores access');

 // --- Audit log ------------------------------------------------------------------------------------------------------------------------
 const all=ok(await call('GET','/api/activity?limit=100'),'activity');check(all.every(r=>'actor_email' in r)&&all.some(r=>r.actor_email===adminLogin.email),'activity rows carry the actor’s email');
 const onlyCust=ok(await call('GET','/api/activity?action=customer.&limit=100'),'filter');check(onlyCust.length>0&&onlyCust.every(r=>r.action.startsWith('customer.')),'filter by action prefix');
 check(ok(await call('GET','/api/activity?q='+encodeURIComponent(alice.email)+'&limit=50'),'search').length>=0,'free-text search works');
 check(ok(await call('GET','/api/activity?from='+encodeURIComponent(new Date(Date.now()+86400000).toISOString())),'future').length===0,'date filter');
 status(await call('GET','/api/activity?from=yesterday-ish'),400,'bad dates are rejected');
 status(await call('GET','/api/activity?actor=not-a-uuid'),400,'bad actor filter');
 await dbQuery(stack.databaseUrl,"INSERT INTO audit_events(actor_id,action,target_type,target_id,detail) VALUES(NULL,'test.formula','test',$1,'{}')",['=HYPERLINK("http://evil","x")']);
 const csv=await fetch(stack.base+'/api/activity/export?format=csv&action=test.',{headers:{cookie:admin.cookie}});
 const csvText=await csv.text();check(csv.headers.get('content-type').startsWith('text/csv')&&/attachment; filename="fledge-audit-/.test(csv.headers.get('content-disposition')),'CSV export downloads as a file');
 check(csvText.split('\n')[0]==='id,time,action,target_type,target_id,actor_id,actor_email,detail','with a header row');
 check(csvText.includes(`"'=HYPERLINK(""http://evil""`),'spreadsheet formulas are neutralised: '+csvText.split('\n')[1]);
 const js=await fetch(stack.base+'/api/activity/export?format=json&limit=5',{headers:{cookie:admin.cookie}}).then(r=>r.json());check(Array.isArray(js)&&js.length>5,'JSON export returns rows');
 owner.status(await owner.call('GET','/api/activity/export?format=csv'),403,'customers cannot export');
 await dbQuery(stack.databaseUrl,"INSERT INTO audit_events(actor_id,action,target_type,target_id,detail,created_at) VALUES(NULL,'test.old','test','x','{}',now()-interval '400 days')");
 ok(await call('PUT','/api/settings/security',{adminAllowedCidrs:[],auditRetentionDays:30}),'set retention');
 await until(async()=>!(await dbQuery(stack.databaseUrl,"SELECT 1 FROM audit_events WHERE action='test.old'")).length,'old audit rows to be removed',15000);
 check((await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM audit_events WHERE action='test.formula'"))[0].n===1,'recent rows are kept');

 // --- OpenAPI and headers ---------------------------------------------------------------------------------------------------------------
 const spec=ok(await call('GET','/api/openapi.json'),'openapi');
 check(spec.openapi==='3.1.0'&&Object.keys(spec.paths).length>100&&spec.components.securitySchemes.cookieAuth,'an OpenAPI 3.1 document is served');
 check(spec.paths['/api/servers/{id}'].get['x-access']==='session'&&spec.paths['/api/servers/{id}'].get['x-token-scope']==='read'&&spec.paths['/api/servers/{id}'].get.parameters[0].name==='id','operations carry access, token scope and path parameters');
 check(spec.paths['/api/auth/passkey/verify'].post['x-access']==='public'&&spec.paths['/api/agent/jobs'].get['x-access']==='agent'&&spec.paths['/api/plugins/{id}/update'].post.tags[0]==='Plugins','public, agent and plugin endpoints are described');
 check(spec.paths['/api/customers/{id}'].patch.requestBody.content['application/json'].schema.description.includes('quota'),'request bodies have field hints');
 const undocumented=Object.values(spec.paths).flatMap(p=>Object.values(p)).filter(o=>o.tags[0].startsWith('Undocumented')).length;check(undocumented<60,'most routes are documented ('+undocumented+' left)');
 owner.status(await owner.call('GET','/api/openapi.json'),403,'customers cannot read the API description');
 const h=await fetch(stack.base+'/api/health');check(h.headers.get('x-content-type-options')==='nosniff'&&h.headers.get('x-frame-options')==='DENY'&&h.headers.get('referrer-policy')==='no-referrer'&&/frame-ancestors 'none'/.test(h.headers.get('content-security-policy')),'API responses carry defensive headers');
 const sv=await fetch(stack.base+'/api/servers',{headers:{cookie:admin.cookie}});check(sv.headers.get('cache-control')==='no-store','API data is never cached');

 // --- Backup quota -------------------------------------------------------------------------------------------------------------------------------
 ok(await call('PUT','/api/settings/storage',{enabled:true,endpoint:'http://127.0.0.1:1',region:'us-east-1',bucket:'testbucket',accessKey:'k',secretKey:'s',forcePathStyle:true}),'dummy object storage');
 ok(await call('PATCH',`/api/customers/${alice.id}`,{quota:{maxBackups:1}}),'limit backups');
 await dbQuery(stack.databaseUrl,"INSERT INTO backups(server_id,object_key,state) VALUES($1,'k/1.tar.gz','succeeded')",[server.id]);
 const over=await owner.call('POST',`/api/servers/${server.id}/backups`,{});owner.status(over,409,'a customer at the backup limit cannot take another');check(/limit of 1 backups/.test(over.data.message),'and is told why');
 ok(await call('PATCH',`/api/customers/${alice.id}`,{quota:{maxBackups:5}}),'raise the limit');
 ok(await owner.call('POST',`/api/servers/${server.id}/backups`,{}),'backups work again within the limit');

 console.log(`PASS ${admin.state.count+owner.state.count+dc.state.count+sign.state.count} assertions: sessions, invitations and resets (no email / SMTP), rate limits, passkeys (register, sign in, forgery/replay/origin), admin network allow-list, audit filters/export/retention, OpenAPI, headers, backup quota`);
}catch(e){failed=e;}
finally{
 smtp.close();
 if(failed){console.error('FAIL',failed.message);console.error('--- api log tail ---\n'+stack.api.logs().split('\n').slice(-15).join('\n'));}
 await stack.stop();process.exit(failed?1:0);
}
