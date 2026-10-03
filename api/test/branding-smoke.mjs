// Appearance (0.6.2.1 "Plumage"): the public document, saving with history and conflicts, images, announcements, custom CSS,
// colours, names in emails and authenticator entries, import and export, personal preferences and the kill switch.
import {SMTPServer} from 'smtp-server';
import {simpleParser} from 'mailparser';
import {randomBytes} from 'node:crypto';
import {bootStack,client,bootstrapAdmin,dbQuery,sleep,startProcess,apiDir,waitFor} from './harness.mjs';

const mails=[];
const smtp=new SMTPServer({authOptional:true,allowInsecureAuth:true,disabledCommands:['STARTTLS'],
 onAuth(auth,session,cb){cb(null,{user:auth.username});},
 onData(stream,session,cb){simpleParser(stream).then(m=>{mails.push({to:m.to?.text,subject:m.subject,text:m.text,from:m.from?.text});cb();}).catch(cb);}});
await new Promise(r=>smtp.listen(0,'127.0.0.1',r));
const smtpPort=smtp.server.address().port;

const stack=await bootStack({db:'fledge_branding_smoke',apiPort:4181,hostPort:4529,mock:null,apiEnv:{SLOW_SWEEP_MS:'1500',RATE_LIMIT_AUTH_WRITE:'5000'}});
const admin=client(stack.base);const {call,ok,status,check}=admin;
const anon=client(stack.base);
let failed=null,second=null;
const rid=()=>randomBytes(3).toString('hex');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
const SVG=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#8fb596"/></svg>');
const upload=async(c,kind,buf,type='image/png',name='file.png')=>{
 const fd=new FormData();fd.append('kind',kind);fd.append('file',new Blob([buf],{type}),name);
 const r=await fetch(stack.base+'/api/branding/assets',{method:'POST',headers:{cookie:c.cookie},body:fd});
 let data=null;try{data=await r.json();}catch{/* no body */}
 return {code:r.status,data};
};
const until=async(fn,label,ms=12000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timed out waiting for '+label);await sleep(200);}};
const doc=async()=>ok(await call('GET','/api/branding/admin'),'admin document');
/** Saves a changed copy of the current document. */
const save=async(patch,reason)=>{
 const cur=await doc(),b=JSON.parse(JSON.stringify(cur.branding));
 patch(b);
 return call('PUT','/api/branding',{branding:b,baseRevision:cur.branding.revision,...(reason?{reason}:{})});
};
try{
 // --- A fresh install looks like Fledge and is readable without signing in ----------------------------------------------
 const first=ok(await anon.call('GET','/api/branding'),'public document');
 check(first.identity.name==='Fledge'&&first.identity.shortName==='Fledge'&&first.revision===0,'a fresh install is called Fledge');
 check(first.images.mark===null&&first.images.login===null&&first.customCss===''&&first.announcement===null,'nothing custom yet');
 check(first.theme.mode==='dark'&&first.theme.allowUserMode===true&&/data-mode="light"/.test(first.theme.css)&&!/data-mode="dark"/.test(first.theme.css),'the default look needs no extra dark CSS');
 check(first.product.name==='Fledge','the product name is always Fledge');
 const r0=await fetch(stack.base+'/api/branding');check(/public/.test(r0.headers.get('cache-control')||'')&&!!r0.headers.get('etag'),'the document is cacheable and has an ETag');
 anon.status(await anon.call('GET','/api/branding/assets/mark'),404,'no custom logo yet');
 anon.status(await anon.call('GET','/api/branding/assets/evil'),401,'unknown image kinds are not served');
 anon.status(await anon.call('GET','/api/branding/admin'),401,'the admin document needs a session');
 anon.status(await anon.call('PUT','/api/branding',{}),401,'saving needs a session');

 const adminLogin=await bootstrapAdmin(admin);
 const cur0=await doc();
 check(cur0.branding.revision===0&&cur0.history.length===0&&cur0.warnings.length===0&&!cur0.disabled,'the admin document starts empty');
 check(cur0.limits.css===32768&&cur0.limits.assets.mark.bytes===524288,'upload limits are published');
 const gen=ok(await call('GET','/api/settings'),'settings');check(!('branding' in gen),'appearance is not part of the generic settings document');
 status(await call('PUT','/api/settings/branding',cur0.branding),404,'and cannot be saved through it');

 // --- Who may change it -------------------------------------------------------------------------------------------------
 const tok=ok(await call('POST','/api/tokens',{name:'t',scopes:['read','provision']}),'api token');
 status(await call('PUT','/api/branding',{branding:cur0.branding},{authorization:'Bearer '+tok.token}),403,'API tokens cannot change the appearance');
 const customerRow=ok(await call('POST','/api/customers',{email:'cust-'+rid()+'@example.test'}),'customer');
 const cust=client(stack.base);ok(await cust.call('POST','/api/auth/login',{email:customerRow.email,password:customerRow.temporaryPassword}),'customer login');
 cust.status(await cust.call('PUT','/api/branding',{branding:cur0.branding}),403,'customers cannot change the appearance');
 cust.status(await cust.call('POST','/api/branding/reset',{}),403,'or reset it');
 cust.status(await cust.call('GET','/api/branding/admin'),403,'or read the admin document');
 check(ok(await cust.call('GET','/api/branding'),'customer reads the public document').identity.name==='Fledge','customers read the public document');

 // --- Dry run -----------------------------------------------------------------------------------------------------------
 const dry=ok(await call('POST','/api/branding/validate',{branding:cur0.branding}),'validate');
 check(dry.ok&&/^#[0-9a-f]{6}$/.test(dry.dark.tokens.bg)&&dry.light.pairs.length>10&&dry.light.pairs.every(p=>p.ok||p.severity==='warning'),'a dry run returns derived colours and the contrast report');
 const badDry=JSON.parse(JSON.stringify(cur0.branding));badDry.identity.name='';
 status(await call('POST','/api/branding/validate',{branding:badDry}),400,'a dry run reports problems');

 // --- Saving, history, conflicts ----------------------------------------------------------------------------------------
 let r=ok(await save(b=>{b.identity.name='Acme Hosting';b.identity.shortName='Acme';b.identity.tagline='Game servers, made easy';b.identity.emailFromName='Acme Ops';b.email.footer='Acme Hosting, Example Street 1\nsupport@acme.example';b.navigation.labels={servers:'Worlds'};b.navigation.links=[{label:'Status page',url:'https://status.acme.example',icon:'activity',newTab:true}];}),'first save');
 check(r.branding.revision===1&&r.branding.identity.name==='Acme Hosting','the first save is revision 1');
 const pub1=ok(await anon.call('GET','/api/branding'),'public after save');
 check(pub1.identity.name==='Acme Hosting'&&pub1.identity.shortName==='Acme'&&pub1.identity.tagline==='Game servers, made easy'&&pub1.revision===1,'everyone sees the new name');
 check(pub1.navigation.labels.servers==='Worlds'&&pub1.navigation.links[0].label==='Status page','navigation changes are public');
 check(!JSON.stringify(pub1).includes('Acme Ops')&&!JSON.stringify(pub1).includes('Example Street'),'email settings stay private');
 const etag1=(await fetch(stack.base+'/api/branding')).headers.get('etag');check(etag1!==r0.headers.get('etag'),'the ETag changes with the revision');
 let h=(await doc()).history;check(h.length===1&&h[0].revision===1&&h[0].by===adminLogin.email&&/identity/.test(h[0].reason),'the history records who changed what');
 const stale=await call('PUT','/api/branding',{branding:{...r.branding,identity:{...r.branding.identity,tagline:'Edited from an old copy'}},baseRevision:0});
 status(stale,409,'a stale revision is a conflict');check(stale.data.details?.revision===1,'the conflict says which revision is current');
 const same=ok(await call('PUT','/api/branding',{branding:r.branding,baseRevision:1}),'unchanged save');
 check(same.branding.revision===1&&(await doc()).history.length===1,'saving without changes creates no new version '+same.branding.revision+' '+(await doc()).history.length);
 check((await dbQuery(stack.databaseUrl,"SELECT 1 FROM audit_events WHERE action='branding.update'")).length===1,'saving is audited');
 status(await save(b=>{b.identity.name='Bad‮Name';}),400,'invisible direction characters are refused');
 status(await save(b=>{b.identity.sourceUrl='javascript:alert(1)';}),400,'script links are refused');
 status(await save(b=>{b.navigation.links[0].url='http://user:pw@evil.example';}),400,'links with credentials are refused');
 status(await save(b=>{b.navigation.labels={bogus:'x'};}),400,'unknown navigation entries are refused');
 status(await call('PUT','/api/branding',{branding:{identity:{name:'x'}}}),400,'a partial document is refused');

 // --- Colours -----------------------------------------------------------------------------------------------------------
 const unreadable=await save(b=>{b.theme.dark.overrides={...b.theme.dark.overrides,text:'#2a2a27'};});
 status(unreadable,400,'unreadable text colours cannot be saved');check(/not readable enough/.test(unreadable.data.message),'with a reason');
 const badKey=await save(b=>{b.theme.dark.overrides={...b.theme.dark.overrides,evil:'#000000'};});status(badKey,400,'unknown colour settings are refused');
 const badColour=await save(b=>{b.theme.dark.accent='url(https://evil.example)';});status(badColour,400,'colours must be hex values');
 r=ok(await save(b=>{b.theme.preset='custom';b.theme.mode='system';b.theme.radius=0;b.theme.font='inter';b.theme.density='compact';b.theme.textScale=1.1;b.theme.dark={accent:'#7cb7ff',neutralHue:262,neutralChroma:0.022};b.theme.light={accent:'#1d62c9',neutralHue:262,neutralChroma:0.014};}),'new theme');
 const pub2=ok(await anon.call('GET','/api/branding'),'public theme');
 check(pub2.theme.mode==='system'&&pub2.theme.font==='inter'&&/--radius-scale:0/.test(pub2.theme.css)&&/--text-scale:1.1/.test(pub2.theme.css)&&/--density:0.88/.test(pub2.theme.css)&&/prefers-color-scheme: light/.test(pub2.theme.css)&&/data-mode="dark"/.test(pub2.theme.css),'the derived stylesheet carries the theme');
 check(!/[<>{}]\s*script/i.test(pub2.theme.css)&&!pub2.theme.css.includes('</'),'generated CSS contains no markup');
 for(const k of ['mode','allowUserMode','font','motion','css'])check(k in pub2.theme,'public theme has '+k);

 // --- Images ------------------------------------------------------------------------------------------------------------
 let up=await upload(admin,'mark',PNG);
 check(up.code===200&&up.data.mime==='image/png'&&up.data.width===1&&/^[a-f0-9]{64}$/.test(up.data.sha256),'a PNG logo uploads');
 const markSha=up.data.sha256;
 check((await anon.call('GET','/api/branding/assets/mark')).code===404,'an uploaded but unsaved image is not public');
 const prev=await fetch(stack.base+`/api/branding/blobs/mark/${markSha}`,{headers:{cookie:admin.cookie}});check(prev.status===200&&prev.headers.get('content-type')==='image/png','administrators can preview it');
 check((await fetch(stack.base+`/api/branding/blobs/mark/${markSha}`)).status===401,'but nobody else can');
 const sv=await upload(admin,'wordmark',SVG,'image/svg+xml','logo.svg');check(sv.code===200&&sv.data.mime==='image/svg+xml','a plain SVG wordmark uploads');
 const evilSvg=await upload(admin,'mark',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),'image/svg+xml','x.svg');check(evilSvg.code===400&&/scripts/.test(evilSvg.data.message),'an SVG with a script is refused');
 const fake=await upload(admin,'mark',Buffer.from('<html><script>alert(1)</script></html>'),'image/png','x.png');check(fake.code===400,'a file that is not an image is refused whatever it claims to be');
 const wrongSlot=await upload(admin,'login',SVG,'image/svg+xml','x.svg');check(wrongSlot.code===400,'the login background cannot be an SVG');
 const big=await upload(admin,'mark',Buffer.concat([PNG,Buffer.alloc(600*1024)]));check(big.code===400||big.code===413,'an oversize logo is refused');
 const noKind=await (async()=>{const fd=new FormData();fd.append('file',new Blob([PNG],{type:'image/png'}),'x.png');const x=await fetch(stack.base+'/api/branding/assets',{method:'POST',headers:{cookie:admin.cookie},body:fd});return x.status;})();check(noKind===400,'the image slot must be named');
 check((await upload(cust,'mark',PNG)).code===403,'customers cannot upload');
 status(await save(b=>{b.assets.mark='a'.repeat(64);}),400,'a reference to an image that was never uploaded is refused');
 r=ok(await save(b=>{b.assets.mark=markSha;b.assets.wordmark=sv.data.sha256;}),'use the images');
 const img=await fetch(stack.base+'/api/branding/assets/mark');
 check(img.status===200&&img.headers.get('content-type')==='image/png'&&Buffer.from(await img.arrayBuffer()).equals(PNG),'the saved logo is public and identical');
 check(/sandbox/.test(img.headers.get('content-security-policy')||'')&&img.headers.get('x-content-type-options')==='nosniff','images are served sandboxed and without sniffing');
 const pub3=ok(await anon.call('GET','/api/branding'),'public images');
 const v=pub3.images.mark.split('v=')[1];
 check(/^\/branding\/mark\?v=[a-f0-9]{16}$/.test(pub3.images.mark)&&pub3.images.favicon===pub3.images.mark&&/\/branding\/wordmark/.test(pub3.images.wordmark),'public image paths are content-addressed, and the favicon falls back to the logo');
 check(/immutable/.test((await fetch(stack.base+`/api/branding/assets/mark?v=${v}`)).headers.get('cache-control')||''),'a matching version is cached for good');
 check(!/immutable/.test((await fetch(stack.base+'/api/branding/assets/mark?v=deadbeef')).headers.get('cache-control')||''),'a wrong version is not');
 const svgOut=await fetch(stack.base+'/api/branding/assets/wordmark');check(svgOut.headers.get('content-type')==='image/svg+xml'&&/default-src 'none'/.test(svgOut.headers.get('content-security-policy')||''),'SVGs carry a restrictive policy');

 // --- Announcements -----------------------------------------------------------------------------------------------------
 const ann=(over)=>b=>{b.announcement={enabled:true,tone:'warn',text:'Maintenance tonight at 22:00 UTC',audience:'everyone',dismissible:true,startsAt:null,endsAt:null,id:'',...over};};
 status(await save(b=>{b.announcement.enabled=true;b.announcement.text='';}),400,'an empty announcement cannot be turned on');
 status(await save(ann({startsAt:'2026-02-01T00:00:00Z',endsAt:'2026-01-01T00:00:00Z'})),400,'an announcement must end after it starts');
 r=ok(await save(ann({})),'announce');const annId1=r.branding.announcement.id;
 check(annId1.length>=8,'a new announcement gets an id');
 check(ok(await anon.call('GET','/api/branding'),'p').announcement?.text==='Maintenance tonight at 22:00 UTC','everyone sees an announcement for everyone, even before signing in');
 r=ok(await save(ann({text:'Maintenance moved to 23:00 UTC'})),'edit announcement');
 check(r.branding.announcement.id!==annId1,'editing the message changes its id, so earlier dismissals do not hide it');
 const annId2=r.branding.announcement.id;
 r=ok(await save(b=>{b.announcement.dismissible=true;}),'resave');check(r.branding.announcement.id===annId2,'an unrelated save keeps the id');
 r=ok(await save(ann({audience:'customers',text:'Customers: your servers restart at 22:00'})),'customers only');
 check(ok(await anon.call('GET','/api/branding'),'p').announcement===null,'a customers-only message is not in the public document');
 check(ok(await cust.call('GET','/api/branding/announcement'),'c').text.startsWith('Customers:'),'customers get it');
 check(ok(await call('GET','/api/branding/announcement'),'a')===null,'administrators do not');
 r=ok(await save(ann({audience:'admins',text:'Admins: renew the licence'})),'admins only');
 check(ok(await call('GET','/api/branding/announcement'),'a').text.startsWith('Admins:')&&ok(await cust.call('GET','/api/branding/announcement'),'c')===null,'admin-only messages reach administrators only');
 r=ok(await save(ann({startsAt:new Date(Date.now()+3600e3).toISOString()})),'scheduled');
 check(ok(await anon.call('GET','/api/branding'),'p').announcement===null,'a message that has not started is hidden');
 r=ok(await save(ann({startsAt:new Date(Date.now()-7200e3).toISOString(),endsAt:new Date(Date.now()-3600e3).toISOString()})),'expired');
 check(ok(await anon.call('GET','/api/branding'),'p').announcement===null,'a message that is over is hidden');
 r=ok(await save(b=>{b.announcement.enabled=false;}),'off');

 // --- Custom CSS --------------------------------------------------------------------------------------------------------
 const cssBad=await save(b=>{b.advanced={customCssEnabled:true,customCss:'@import url(https://evil.example/x.css);'};});
 status(cssBad,400,'CSS that loads other files is refused');check(/@import/.test(cssBad.data.message),'and says why');
 status(await save(b=>{b.advanced={customCssEnabled:true,customCss:'.a{background:url(https://evil.example/p.png)}'};}),400,'remote images in CSS are refused');
 status(await save(b=>{b.advanced={customCssEnabled:false,customCss:'</style><script>alert(1)</script>'};}),400,'CSS with markup is refused even when switched off');
 check(ok(await anon.call('GET','/api/branding'),'p').customCss==='','no CSS is served until it is switched on');
 r=ok(await save(b=>{b.advanced={customCssEnabled:true,customCss:'/* mine */ .brand span{letter-spacing:.05em}'};}),'css on');
 check(ok(await anon.call('GET','/api/branding'),'p').customCss.includes('letter-spacing:.05em')&&!ok(await anon.call('GET','/api/branding'),'p').customCss.includes('mine'),'CSS is served without comments once switched on');
 r=ok(await save(b=>{b.advanced.customCssEnabled=false;}),'css off');
 check(ok(await anon.call('GET','/api/branding'),'p').customCss==='','and withdrawn when switched off');

 // --- The name in text the server writes --------------------------------------------------------------------------------
 ok(await call('PUT','/api/settings/email',{enabled:true,host:'127.0.0.1',port:smtpPort,security:'none',user:'',password:'',from:'panel@example.test'}),'email settings');
 const invitee=ok(await call('POST','/api/customers',{email:'invitee-'+rid()+'@example.test'}),'invitee');
 ok(await call('POST',`/api/customers/${invitee.id}/invite`),'invite');
 const inviteMail=await until(()=>mails.find(m=>m.to?.includes(invitee.email)),'invitation email');
 check(inviteMail.subject==='You have been invited to Acme Hosting'&&/invited to Acme Hosting, the game server panel/.test(inviteMail.text),'invitations use the panel name');
 check(/Acme Ops/.test(inviteMail.from||'')&&/panel@example\.test/.test(inviteMail.from||''),'the sender gets the configured display name');
 check(inviteMail.text.includes('Example Street 1')&&inviteMail.text.includes('support@acme.example'),'every email ends with the footer');
 ok(await call('POST','/api/settings/email/test',{to:'tester@example.test'}),'test email');
 const testMail=await until(()=>mails.find(m=>m.to?.includes('tester@example.test')),'test email');
 check(testMail.subject==='Acme Hosting test email'&&/Acme Hosting can send email/.test(testMail.text),'the test email uses the panel name');
 const totp=ok(await call('POST','/api/auth/2fa/setup',{}),'2fa setup');
 check(totp.uri.startsWith('otpauth://totp/Acme%20Hosting:')&&totp.uri.includes('issuer=Acme%20Hosting'),'authenticator apps show the panel name');
 const fromHeader=await call('POST','/api/settings/email/test',{to:'second@example.test'});ok(fromHeader,'second test mail');

 // --- History and restore -----------------------------------------------------------------------------------------------
 h=(await doc()).history;
 check(h.length>=10&&h[0].revision>h[1].revision,'versions are listed newest first');
 const firstSave=await call('GET',`/api/branding/history/${h[h.length-1].id}`);const oldDoc=ok(firstSave,'one version');
 check(oldDoc.revision===h[h.length-1].revision&&oldDoc.value.identity.name,'a single version can be read');
 const nameVersion=h.find(x=>x.revision===1);
 const toRestore=nameVersion||h[h.length-1];
 r=ok(await call('POST',`/api/branding/history/${toRestore.id}/restore`,{}),'restore');
 check(r.branding.revision>h[0].revision&&(await doc()).history[0].reason===`Restored version ${toRestore.revision}`,'restoring creates a new version');
 check(ok(await anon.call('GET','/api/branding'),'p').identity.name==='Acme Hosting'&&ok(await anon.call('GET','/api/branding'),'p').theme.mode==='dark','restoring brings the old settings back');
 check(ok(await anon.call('GET','/api/branding'),'p').images.mark===null,'including the images the old version had');
 status(await call('POST','/api/branding/history/999999/restore',{}),404,'unknown versions are not found');
 cust.status(await cust.call('POST',`/api/branding/history/${toRestore.id}/restore`,{}),403,'customers cannot restore');
 // The history keeps the last twenty versions.
 for(let i=0;i<22;i++)ok(await save(b=>{b.identity.tagline=`Tagline ${i}`;}),'bulk save '+i);
 h=(await doc()).history;check(h.length===20,'only the last 20 versions are kept');

 // --- Images of old versions survive until nothing refers to them ------------------------------------------------------
 const keepSha=(await upload(admin,'favicon',PNG,'image/png','f.png')).data.sha256;
 r=ok(await save(b=>{b.assets.favicon=keepSha;}),'favicon');
 ok(await save(b=>{b.assets.favicon=null;}),'favicon removed');
 await dbQuery(stack.databaseUrl,"INSERT INTO branding_blobs(sha256,kind,mime,bytes,created_at) VALUES($1,'login','image/png',$2,now()-interval '3 days')",['b'.repeat(64),PNG]);
 await until(async()=>(await dbQuery(stack.databaseUrl,"SELECT 1 FROM branding_blobs WHERE sha256=$1",['b'.repeat(64)])).length===0,'sweep of an orphaned image');
 check((await dbQuery(stack.databaseUrl,"SELECT 1 FROM branding_blobs WHERE sha256=$1 AND kind='favicon'",[keepSha])).length===1,'an image used by a kept version is not swept');

 // --- Reset, export, import ---------------------------------------------------------------------------------------------
 ok(await save(b=>{b.assets.mark=markSha;b.identity.name='Exported Brand';}),'before export');
 const exp=ok(await call('GET','/api/branding/export'),'export');
 check(exp.format==='fledge-theme'&&exp.formatVersion===1&&exp.branding.identity.name==='Exported Brand'&&exp.images.mark.mime==='image/png'&&!('revision' in exp.branding),'a theme file has the document and its images');
 r=ok(await call('POST','/api/branding/reset',{}),'reset');
 check(r.branding.identity.name==='Fledge'&&r.branding.assets.mark===null&&r.branding.revision>0,'reset goes back to Fledge');
 const pubAfterReset=ok(await anon.call('GET','/api/branding'),'p');check(pubAfterReset.images.mark===null&&pubAfterReset.identity.name==='Fledge'&&pubAfterReset.customCss==='','and everyone sees it');
 const imp=ok(await call('POST','/api/branding/import',exp),'import');
 check(imp.branding.identity.name==='Exported Brand'&&/^[a-f0-9]{64}$/.test(imp.branding.assets.mark)&&imp.changed.includes('identity'),'import returns a document to review');
 check(ok(await anon.call('GET','/api/branding'),'p').identity.name==='Fledge','import alone changes nothing');
 r=ok(await call('PUT','/api/branding',{branding:imp.branding,baseRevision:imp.branding.revision}),'save the imported theme');
 check(ok(await anon.call('GET','/api/branding'),'p').identity.name==='Exported Brand'&&ok(await anon.call('GET','/api/branding'),'p').images.mark!==null,'saving applies it, images included');
 status(await call('POST','/api/branding/import',{format:'other'}),400,'other files are refused');
 status(await call('POST','/api/branding/import',{...exp,images:{mark:{mime:'image/png',data:Buffer.from('<script>x</script>').toString('base64')}}}),400,'an import with a fake image is refused');
 status(await call('POST','/api/branding/import',{...exp,branding:{...exp.branding,advanced:{customCssEnabled:true,customCss:'@import "x";'}}}),400,'an import with hostile CSS is refused');
 cust.status(await cust.call('GET','/api/branding/export'),403,'customers cannot export');

 // --- Personal preferences ----------------------------------------------------------------------------------------------
 check(ok(await cust.call('GET','/api/auth/me'),'me').preferences.mode===null,'nobody has a personal choice at first');
 ok(await cust.call('PUT','/api/auth/preferences',{mode:'light'}),'choose light');
 check(ok(await cust.call('GET','/api/auth/me'),'me').preferences.mode==='light','a personal choice follows the account');
 cust.status(await cust.call('PUT','/api/auth/preferences',{mode:'purple'}),400,'unknown modes are refused');
 ok(await cust.call('PUT','/api/auth/preferences',{mode:null}),'clear');
 check(ok(await cust.call('GET','/api/auth/me'),'me').preferences.mode===null,'and can be cleared');
 status(await call('PUT','/api/auth/preferences',{mode:'dark'},{authorization:'Bearer '+tok.token}),403,'tokens have no preferences');

 // --- The kill switch ---------------------------------------------------------------------------------------------------
 second=startProcess('api2',apiDir,'src/index.ts',{DATABASE_URL:stack.databaseUrl,ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',WEB_ORIGIN:'http://localhost:3000',PORT:'4182',BRANDING_DISABLED:'true',SLOW_SWEEP_MS:'60000'});
 await waitFor('http://127.0.0.1:4182/api/health');
 const off=await (await fetch('http://127.0.0.1:4182/api/branding')).json();
 check(off.disabled===true&&off.identity.name==='Fledge'&&off.images.mark===null&&off.customCss==='','BRANDING_DISABLED serves the built-in look whatever is stored');
 const second_admin=client('http://127.0.0.1:4182');
 ok(await second_admin.call('POST','/api/auth/login',{email:adminLogin.email,password:adminLogin.password,totp:(await import('otplib')).authenticator.generate(adminLogin.secret)}),'login on the second API');
 second_admin.status(await second_admin.call('PUT','/api/branding',{branding:imp.branding}),409,'and nothing can be saved while it is on');
 second.kill();second=null;

 console.log(`PASS ${admin.state.count+anon.state.count+cust.state.count} assertions: public document and caching, who may change it, saving with history, conflicts and restore, colours and contrast, images (PNG, SVG, hostile files, limits, caching), announcements by audience and time, custom CSS rules, names in emails and authenticator entries, import, export and reset, personal preferences, BRANDING_DISABLED`);
}catch(e){failed=e;}
finally{
 smtp.close();
 if(failed){console.error('FAIL',failed.message);console.error('--- api log tail ---\n'+stack.api.logs().split('\n').slice(-15).join('\n'));}
 second?.kill();
 await stack.stop();process.exit(failed?1:0);
}
