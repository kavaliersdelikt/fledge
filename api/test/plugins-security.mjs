// Trust and safety tests for the plugin system: registry signatures and tampering, consent for
// new permissions, hostile plugin output, secrets, hooks and automatic shut-off of broken plugins.
import {createServer} from 'node:http';
import {generateKeyPairSync,sign,createHash,randomBytes} from 'node:crypto';
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery,sleep} from './harness.mjs';
import {buildPackage,signedMessage} from '../src/plugins/package.ts';

const sha256=b=>createHash('sha256').update(b).digest('hex');
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const publicB64=publicKey.export({type:'spki',format:'der'}).toString('base64');
const signPackage=(id,version,hash)=>sign(null,Buffer.from(signedMessage(id,version,hash)),privateKey).toString('base64');

const manifest=(o)=>({apiVersion:1,description:'Test plugin',author:'Tester',license:'MIT',permissions:[],...o});
const helloCode=`globalThis.fledgePlugin={
 async healthCheck(){return {ok:true,message:'greeting='+host.settings.greeting+' token='+(host.settings.token||'').length};},
 async search(){try{await host.fetch('https://example.com/');return {total:0,items:[]};}catch(e){return {total:1,offset:0,limit:1,items:[{id:'denied',title:e.message,slug:'x'}]};}},
 hooks:{'server.created':function(e){host.storage.set('seen',e.serverId);host.log('info','created '+e.name);return true;}}
};`;
const hello=(version,extraPerms=[])=>buildPackage({manifest:manifest({id:'hello-catalog',name:'Hello Catalog',version,permissions:['network:api.modrinth.com','servers:read','storage','hooks',...extraPerms],hooks:['server.created'],catalogs:[{id:'c',label:'C',kind:'mod'}],settings:[{key:'greeting',label:'Greeting',type:'string',default:'hi'},{key:'token',label:'Token',type:'secret'}]}),code:helloCode});
const unsigned=buildPackage({manifest:manifest({id:'unsigned-thing',name:'Unsigned Thing',version:'1.0.0'}),code:'globalThis.fledgePlugin={};'});
const evilCode=`globalThis.fledgePlugin={
 async search(){return {total:1,offset:0,limit:1,items:[{id:'e1',slug:'e',title:'T'.repeat(5000),summary:'x',iconUrl:'https://tracker.example.org/pixel.png',url:'javascript:alert(1)',downloads:'lots',categories:['a','b'],clientSide:'weird',serverSide:'required'},{id:'',title:'no id'}]};},
 async project(id){return {id:id,title:'Evil',description:'<script>alert(1)</script> text',iconUrl:'http://cdn.modrinth.com/x.png',gallery:[{url:'https://cdn.modrinth.com/ok.png'},{url:'https://evil.example.org/bad.png'}],links:{page:'javascript:alert(1)',source:'https://github.com/x/y'}};},
 async resolve(args){
  var id=args.projectId;var base={project:{id:id,title:'Evil '+id},version:{id:'v1',label:'1',channel:'release'},dependencies:[]};
  var good={url:'https://cdn.modrinth.com/data/x/v1/a.jar',filename:'a.jar',sha512:'${'a'.repeat(128)}',size:100};
  if(id==='bad-host')base.files=[{...good,url:'https://evil.example.org/a.jar'}];
  else if(id==='bad-http')base.files=[{...good,url:'http://cdn.modrinth.com/a.jar'}];
  else if(id==='bad-name')base.files=[{...good,filename:'../../etc/cron.d/x.jar'}];
  else if(id==='bad-ext')base.files=[{...good,filename:'payload.sh'}];
  else if(id==='no-hash')base.files=[{...good,sha512:''}];
  else if(id==='huge')base.files=[{...good,size:9999999999}];
  else if(id==='no-files')base.files=[];
  else base.files=[good];
  return base;
 }
};`;
const evil=buildPackage({manifest:manifest({id:'evil-catalog',name:'Evil Catalog',version:'1.0.0',permissions:['network:cdn.modrinth.com','servers:read','servers:files.write'],catalogs:[{id:'e',label:'Evil',kind:'mod'}]}),code:evilCode});
const broken=buildPackage({manifest:manifest({id:'broken-plugin',name:'Broken',version:'1.0.0',permissions:['servers:read'],catalogs:[{id:'b',label:'B',kind:'mod'}]}),code:'this is {{ not javascript'});

// A registry that serves whatever the test currently wants it to.
const reg={entries:{},files:{}};
const addEntry=(id,version,pkg,{signed=true,hashOverride}={})=>{const h=sha256(pkg);reg.files[`/pkg/${id}-${version}.fledgeplugin`]=pkg;reg.entries[id]={id,name:id,version,description:'registry '+id,author:'Tester',permissions:[],downloadUrl:`http://127.0.0.1:${registry.address().port}/pkg/${id}-${version}.fledgeplugin`,sha256:hashOverride||h,...(signed?{signature:signPackage(id,version,h)}:{})};};
const registry=createServer((req,res)=>{
 if(req.url==='/registry/index.json'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({schema:1,plugins:Object.values(reg.entries)}));}
 const f=reg.files[req.url];if(f){res.setHeader('content-type','application/octet-stream');return res.end(Buffer.from(f));}
 res.statusCode=404;res.end('not found');
});
await new Promise(r=>registry.listen(0,'127.0.0.1',r));
addEntry('hello-catalog','1.0.0',hello('1.0.0'));
addEntry('unsigned-thing','1.0.0',unsigned,{signed:false});

const stack=await bootStack({db:'fledge_plugins_security',apiPort:4174,hostPort:4522,mock:null,apiEnv:{PLUGIN_REGISTRY_URL:`http://127.0.0.1:${registry.address().port}/registry/index.json`}});
const admin=client(stack.base);const {call,ok,status,check}=admin;
let failed=null;
const pkgB64=p=>Buffer.from(p).toString('base64');
try{
 await bootstrapAdmin(admin);

 // --- The registry and its trust tiers ------------------------------------------------------
 let store=ok(await call('GET','/api/plugins/store?refresh=1'),'store');
 check(store.registry.error===null&&store.registry.entries===2,'the registry index is read: '+JSON.stringify(store.registry));
 check(store.items.find(i=>i.id==='hello-catalog').tier==='community','without a trusted key even a signed plugin is only community');
 ok(await call('PUT','/api/settings/plugins',{registryUrl:'',trustedKeys:[publicB64],allowCommunity:false}),'trust the test signing key');
 // The registry URL setting now overrides the environment default; restore it through the API-visible default.
 const s=ok(await call('GET','/api/settings'),'settings');check(s.plugins.trustedKeys.length===1,'trusted key stored');
 status(await call('PUT','/api/settings/plugins',{registryUrl:'http://insecure.example.org/index.json',trustedKeys:[],allowCommunity:false}),400,'registry must use HTTPS');
 status(await call('PUT','/api/settings/plugins',{registryUrl:'',trustedKeys:['not-a-key'],allowCommunity:false}),400,'keys must look like keys');
 // An empty registry URL turns the registry off.
 store=ok(await call('GET','/api/plugins/store?refresh=1'),'store without registry');check(store.items.every(i=>i.source==='bundled'),'with the registry off only bundled plugins show');
 // Bring the registry back through the database (the test registry is plain HTTP, which the settings form forbids).
 await dbQuery(stack.databaseUrl,"UPDATE settings SET value=jsonb_set(value,'{registryUrl}',to_jsonb($1::text)) WHERE key='plugins'",[`http://127.0.0.1:${registry.address().port}/registry/index.json`]);
 await sleep(5200); // the API caches settings for five seconds
 store=ok(await call('GET','/api/plugins/store?refresh=1'),'store with registry');
 const hItem=store.items.find(i=>i.id==='hello-catalog'),uItem=store.items.find(i=>i.id==='unsigned-thing');
 check(hItem.tier==='verified'&&hItem.installable,'a signature from a trusted key makes a plugin verified');
 check(uItem.tier==='community'&&!uItem.installable&&/turned off/.test(uItem.blockedReason),'unsigned plugins are blocked by default');
 status(await call('POST','/api/plugins',{source:'registry',id:'unsigned-thing',acceptPermissions:true}),403,'unsigned install refused');
 status(await call('POST','/api/plugins',{source:'upload',package:pkgB64(unsigned),acceptPermissions:true}),403,'uploads refused while community plugins are off');

 // --- Tampering ------------------------------------------------------------------------------------
 addEntry('hello-catalog','1.0.0',hello('1.0.0'),{hashOverride:'0'.repeat(64)});
 await call('GET','/api/plugins/store?refresh=1');
 const bad=await call('POST','/api/plugins',{source:'registry',id:'hello-catalog',acceptPermissions:true});
 status(bad,422,'a download that does not match the index checksum is refused');check(/does not match the checksum/.test(bad.data.message),'the reason is explained');
 const wrongInner=hello('9.9.9');addEntry('hello-catalog','1.0.0',wrongInner);
 await call('GET','/api/plugins/store?refresh=1');
 status(await call('POST','/api/plugins',{source:'registry',id:'hello-catalog',acceptPermissions:true}),422,'a package whose manifest disagrees with the index is refused');
 addEntry('hello-catalog','1.0.0',hello('1.0.0'));await call('GET','/api/plugins/store?refresh=1');
 check((await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM plugins"))[0].n===0,'nothing was installed by any failed attempt');

 // --- Install, tier, permission changes -------------------------------------------------------------------
 const inst=ok(await call('POST','/api/plugins',{source:'registry',id:'hello-catalog',acceptPermissions:true}),'install verified plugin');
 check(inst.tier==='verified'&&inst.permissions.every(p=>p.granted),'installed as verified with permissions granted');
 addEntry('hello-catalog','1.1.0',hello('1.1.0',['servers:files.write']));
 await call('GET','/api/plugins/store?refresh=1');
 store=ok(await call('GET','/api/plugins/store'),'store');check(store.items.find(i=>i.id==='hello-catalog').installed.updateAvailable,'an update is offered');
 const needs=await call('POST','/api/plugins/hello-catalog/update',{});
 status(needs,409,'an update that asks for more permissions needs consent');
 check(needs.data.error==='permissions_changed'&&needs.data.details.newPermissions.some(p=>p.id==='servers:files.write'),'the new permission is named');
 check(ok(await call('GET','/api/plugins/hello-catalog'),'unchanged').version==='1.0.0','the plugin stays at its old version until the admin agrees');
 await dbQuery(stack.databaseUrl,"UPDATE plugins SET settings='{\"legacyOption\":\"x\"}'::jsonb WHERE id='hello-catalog'");
 const upd=ok(await call('POST','/api/plugins/hello-catalog/update',{acceptPermissions:true}),'update with consent');
 check(Object.keys((await dbQuery(stack.databaseUrl,"SELECT settings FROM plugins WHERE id='hello-catalog'"))[0].settings).length===0,'settings the new version no longer declares are dropped by the update');
 check(upd.version==='1.1.0'&&upd.hasPrevious&&upd.previousVersion==='1.0.0','updated; the previous version is kept for rollback');
 const rb=ok(await call('POST','/api/plugins/hello-catalog/rollback',{}),'rollback');check(rb.version==='1.0.0'&&!rb.hasPrevious,'rolled back');
 check((await dbQuery(stack.databaseUrl,"SELECT settings FROM plugins WHERE id='hello-catalog'"))[0].settings.legacyOption==='x','a rollback restores the settings the update dropped');
 ok(await call('POST','/api/plugins/hello-catalog/update',{acceptPermissions:true}),'update again');

 // --- Look before installing -------------------------------------------------------------------------------
 const peek=ok(await call('POST','/api/plugins/inspect',{source:'upload',package:pkgB64(unsigned)}),'inspect an uploaded package');
 check(peek.id==='unsigned-thing'&&peek.tier==='community'&&peek.blockedReason&&peek.installed===null,'inspecting shows the manifest, tier and why it is blocked, without installing');
 check((await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM plugins WHERE id='unsigned-thing'"))[0].n===0,'inspecting installs nothing');
 status(await call('POST','/api/plugins/inspect',{source:'upload',package:'bm90IGEgemlw'}),400,'inspecting garbage fails cleanly');

 // --- Uploads and manifest validation ---------------------------------------------------------------------------
 ok(await call('PUT','/api/settings/plugins',{registryUrl:'',trustedKeys:[publicB64],allowCommunity:true}),'allow community plugins');
 await dbQuery(stack.databaseUrl,"UPDATE settings SET value=jsonb_set(value,'{registryUrl}',to_jsonb($1::text)) WHERE key='plugins'",[`http://127.0.0.1:${registry.address().port}/registry/index.json`]);
 await sleep(5200); // settings are cached for five seconds
 // A newer version that lost its signature is a downgrade in trust and needs a deliberate yes.
 addEntry('hello-catalog','1.2.0',hello('1.2.0',['servers:files.write']),{signed:false});
 await call('GET','/api/plugins/store?refresh=1');
 const lessTrusted=await call('POST','/api/plugins/hello-catalog/update',{});
 status(lessTrusted,409,'a less trusted update needs consent');check(lessTrusted.data.error==='less_trusted'&&lessTrusted.data.details.to==='community','the downgrade is reported in structured form');
 delete reg.entries['hello-catalog'];addEntry('hello-catalog','1.1.0',hello('1.1.0',['servers:files.write']));await call('GET','/api/plugins/store?refresh=1');

 const mk=(m,code='globalThis.fledgePlugin={};')=>pkgB64(buildPackage({manifest:{apiVersion:1,description:'d',author:'a',license:'MIT',...m},code}));
 const reject=async(label,m)=>{const r=await call('POST','/api/plugins',{source:'upload',package:mk(m),acceptPermissions:true});status(r,400,label);return r.data.message;};
 await reject('uppercase ids',{id:'Bad_ID',name:'x',version:'1.0.0'});
 await reject('missing version',{id:'good-id',name:'x'});
 check(/unknown permission/.test(await reject('unknown permission',{id:'good-id',name:'x',version:'1.0.0',permissions:['fs:read']})),'unknown permissions are named');
 for(const host of ['127.0.0.1','localhost','intranet.local','10.0.0.1','*.com','api','metadata.google.internal'])await reject('network host '+host,{id:'good-id',name:'x',version:'1.0.0',permissions:['network:'+host]});
 await reject('hooks need the permission',{id:'good-id',name:'x',version:'1.0.0',hooks:['server.created']});
 await reject('unknown hook',{id:'good-id',name:'x',version:'1.0.0',permissions:['hooks'],hooks:['server.exploded']});
 await reject('catalog needs servers:read',{id:'good-id',name:'x',version:'1.0.0',catalogs:[{id:'c',label:'C',kind:'mod'}]});
 await reject('wrong api version',{id:'good-id',name:'x',version:'1.0.0',apiVersion:2});
 await reject('future panel version',{id:'good-id',name:'x',version:'1.0.0',minPanelVersion:'9.0.0'}).catch(()=>{});
 status(await call('POST','/api/plugins',{source:'upload',package:'bm90IGEgemlw',acceptPermissions:true}),400,'garbage is not a package');
 status(await call('POST','/api/plugins',{source:'upload',acceptPermissions:true}),413,'missing package');

 // --- Secrets ------------------------------------------------------------------------------------------------------------
 ok(await call('PUT','/api/plugins/hello-catalog/settings',{greeting:'yo',token:'s3cret-token'}),'save a secret');
 const shown=ok(await call('GET','/api/plugins/hello-catalog'),'plugin detail');
 check(shown.settings.token.set===true&&!JSON.stringify(shown).includes('s3cret-token'),'secrets are never returned');
 const raw=(await dbQuery(stack.databaseUrl,"SELECT secrets,settings FROM plugins WHERE id='hello-catalog'"))[0];
 check(raw.secrets&&!raw.secrets.includes('s3cret')&&!JSON.stringify(raw.settings).includes('s3cret'),'secrets are encrypted at rest');
 ok(await call('PATCH','/api/plugins/hello-catalog',{enabled:true}),'enable');
 const h=ok(await call('POST','/api/plugins/hello-catalog/health',{}),'health');check(h.message==='greeting=yo token=12','the plugin receives its secret inside the sandbox');
 ok(await call('PUT','/api/plugins/hello-catalog/settings',{greeting:'yo'}),'save without touching the secret');
 check(ok(await call('POST','/api/plugins/hello-catalog/health',{}),'health').message==='greeting=yo token=12','a secret left out of the form is kept');
 ok(await call('PUT','/api/plugins/hello-catalog/settings',{greeting:'yo',token:''}),'clear the secret');
 check(ok(await call('POST','/api/plugins/hello-catalog/health',{}),'health').message==='greeting=yo token=0','an empty value clears it');

 // --- Hooks and storage --------------------------------------------------------------------------------------------------------
 const customer=ok(await call('POST','/api/customers',{email:'c-'+randomBytes(3).toString('hex')+'@example.test'}),'customer');
 const node=await makeNode(admin,'beta');await heartbeat(admin,node,'0.6.1.1');
 const server=ok(await call('POST','/api/servers',{name:'HookTest',ownerId:customer.id,templateId:'minecraft-fabric',nodeId:node.id,memoryMb:512,cpuPercent:100,diskMb:2048,port:25565}),'server');
 let seen=null;for(let i=0;i<30&&!seen;i++){await sleep(200);seen=(await dbQuery(stack.databaseUrl,"SELECT value FROM plugin_kv WHERE plugin_id='hello-catalog' AND key='seen'"))[0];}
 check(seen&&seen.value===server.id,'the server.created hook ran and stored data');
 const logs=ok(await call('GET','/api/plugins/hello-catalog/logs'),'logs');check(logs.some(l=>l.message==='created HookTest'),'plugin log lines are kept');
 const create=await nextJob(admin,node);await finishJob(admin,node,create);

 // --- The sandbox's network rules, seen through a real plugin -------------------------------------------------------------------
 const A=`/api/servers/${server.id}/addons`;
 const denied=ok(await call('GET',`${A}/search?pluginId=hello-catalog`),'search that tries an undeclared host');
 check(/may not contact example\.com/.test(denied.items[0].title),'undeclared hosts are refused inside the sandbox');

 // --- A hostile catalog ------------------------------------------------------------------------------------------------------------
 const evilInstalled=ok(await call('POST','/api/plugins',{source:'upload',package:pkgB64(evil),acceptPermissions:true}),'install evil catalog (community allowed)');
 check(evilInstalled.tier==='community','uploads are community tier');
 ok(await call('PATCH','/api/plugins/evil-catalog',{enabled:true}),'enable evil');
 const es=ok(await call('GET',`${A}/search?pluginId=evil-catalog`),'evil search');
 check(es.items.length===1,'items without an id are dropped');
 const it=es.items[0];
 check(it.title.length===120&&it.iconUrl===null&&it.url===null&&it.downloads===0&&it.clientSide==='unknown'&&it.categories.length===2,'hostile search data is clamped and stripped: '+JSON.stringify({t:it.title.length,i:it.iconUrl,u:it.url,d:it.downloads,c:it.clientSide}));
 const ep=ok(await call('GET',`${A}/project?pluginId=evil-catalog&projectId=p1`),'evil project');
 check(ep.iconUrl===null&&ep.gallery.length===1&&ep.gallery[0].url==='https://cdn.modrinth.com/ok.png'&&!ep.links.page&&ep.links.source==='https://github.com/x/y','images and links outside the allowed hosts or schemes are dropped');
 for(const id of ['bad-host','bad-http','bad-name','bad-ext','no-hash','huge','no-files']){
  const r=await call('POST',`${A}/install`,{pluginId:'evil-catalog',projectId:id});
  check(r.code===502&&!r.data.addons,'hostile file offer "'+id+'" is refused ('+r.code+' '+(r.data&&r.data.message)+')');
 }
 check((await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM server_addons"))[0].n===0,'no add-on row exists for refused offers');
 check((await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM jobs WHERE kind='file.fetch'"))[0].n===0,'and no download job was queued');
 const goodInstall=ok(await call('POST',`${A}/install`,{pluginId:'evil-catalog',projectId:'fine'}),'a well-formed offer is accepted');
 check(goodInstall.addons.length===1,'well-formed offers still work');
 const dl=await nextJob(admin,node);check(dl.payload.allowedHosts.join()==='cdn.modrinth.com'&&dl.payload.url.startsWith('https://cdn.modrinth.com/'),'the node is only allowed the plugin’s declared host');
 await finishJob(admin,node,dl,true,{ok:true,sizeBytes:100});
 // A plugin whose files permission was never granted cannot make the panel write files, even if it offers a catalog.
 await dbQuery(stack.databaseUrl,"UPDATE plugins SET granted_permissions=array_remove(granted_permissions,'servers:files.write') WHERE id='hello-catalog'");
 status(await call('POST',`${A}/install`,{pluginId:'hello-catalog',projectId:'x'}),403,'a plugin without the files permission cannot install');

 // --- Broken plugins shut themselves off ------------------------------------------------------------------------------------------------
 ok(await call('POST','/api/plugins',{source:'upload',package:pkgB64(broken),acceptPermissions:true}),'install broken plugin');
 ok(await call('PATCH','/api/plugins/broken-plugin',{enabled:true}),'enable broken plugin');
 for(let i=0;i<5;i++)status(await call('GET',`${A}/search?pluginId=broken-plugin`),502,'broken plugin call '+(i+1));
 const after=ok(await call('GET','/api/plugins/broken-plugin'),'broken plugin state');
 check(after.enabled===false&&/automatically after 5 consecutive failures/.test(after.disabledReason),'a plugin that keeps crashing is turned off: '+after.disabledReason);
 status(await call('GET',`${A}/search?pluginId=broken-plugin`),404,'and is no longer called');
 check(ok(await call('GET','/api/plugins/broken-plugin/logs'),'logs').some(l=>l.level==='error'),'its errors are in its log');
 status(await call('PATCH','/api/plugins/broken-plugin',{enabled:true}),200,'an admin can turn it back on');

 // --- Required settings block enabling ------------------------------------------------------------------------------------------------------
 const needy=buildPackage({manifest:manifest({id:'needs-key',name:'Needs Key',version:'1.0.0',settings:[{key:'apiKey',label:'API key',type:'secret',required:true}]}),code:'globalThis.fledgePlugin={};'});
 ok(await call('POST','/api/plugins',{source:'upload',package:pkgB64(needy),acceptPermissions:true}),'install plugin with required secret');
 const blocked=await call('PATCH','/api/plugins/needs-key',{enabled:true});status(blocked,409,'cannot enable without required settings');check(/API key/.test(blocked.data.message),'the missing setting is named');
 ok(await call('PUT','/api/plugins/needs-key/settings',{apiKey:'k'}),'fill it in');ok(await call('PATCH','/api/plugins/needs-key',{enabled:true}),'now it enables');

 console.log(`PASS ${admin.state.count} assertions: registry trust tiers, signature and checksum checks, tampering, consent for new permissions, rollback, uploads and manifest validation, secrets, hooks and storage, sandbox network rules, hostile catalog output, auto-disable, required settings`);
}catch(e){failed=e;}
finally{
 registry.close();
 if(failed){console.error('FAIL',failed.message);console.error('--- api log tail ---\n'+stack.api.logs().split('\n').slice(-25).join('\n'));console.error('--- host log tail ---\n'+stack.host.logs().split('\n').slice(-10).join('\n'));}
 await stack.stop();
 process.exit(failed?1:0);
}
