// Integration test for the plugin system and the Modrinth add-on flow. Boots a mock Modrinth,
// the real plugin host and the real API against a throw-away database, and plays the node agent.
import {startMock,fileSha512} from './modrinth-mock.mjs';
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery,sleep} from './harness.mjs';
import {randomBytes} from 'node:crypto';

const mock=await startMock();
const stack=await bootStack({db:'fledge_plugins_smoke',apiPort:4173,hostPort:4521,mock,quiet:process.env.QUIET==='0'?false:true});
const admin=client(stack.base);
const {call,ok,status,check}=admin;
let failed=null;
try{
 status(await call('GET','/api/plugins'),401,'plugins need authentication');
 const adminLogin=await bootstrapAdmin(admin);

 // --- Plugin host and store -----------------------------------------------------------
 const list=ok(await call('GET','/api/plugins'),'plugin list');
 check(list.host.ok===true&&list.host.sandbox==='quickjs-wasm','the plugin host is reachable and sandboxed');
 check(list.plugins.length===0,'nothing is installed by default');
 const store=ok(await call('GET','/api/plugins/store'),'store');
 const ids=store.items.map(i=>i.id).sort();
 check(JSON.stringify(ids)===JSON.stringify(['modrinth-mods','modrinth-plugins']),'both bundled plugins are offered');
 const modsItem=store.items.find(i=>i.id==='modrinth-mods');
 check(modsItem.tier==='bundled'&&!modsItem.installed&&modsItem.installable,'bundled plugin is installable');
 check(modsItem.permissions.some(p=>p.id==='network:api.modrinth.com'&&/Connect to api\.modrinth\.com/.test(p.text)),'permissions are described in plain language');

 // --- Install needs consent; then enable -------------------------------------------------
 status(await call('POST','/api/plugins',{source:'bundled',id:'modrinth-mods'}),400,'install without approving permissions');
 status(await call('POST','/api/plugins',{source:'bundled',id:'nope'}),404,'unknown bundled plugin');
 status(await call('POST','/api/plugins',{source:'weird'}),400,'unknown source');
 const installed=ok(await call('POST','/api/plugins',{source:'bundled',id:'modrinth-mods',acceptPermissions:true}),'install modrinth-mods');
 check(installed.enabled===false&&installed.tier==='bundled','a fresh install is off until enabled');
 status(await call('POST','/api/plugins',{source:'bundled',id:'modrinth-mods',acceptPermissions:true}),409,'double install');
 const health=ok(await call('POST','/api/plugins/modrinth-mods/health',{}),'health check');
 check(health.ok&&/Connected to Modrinth \(2 loaders known\)/.test(health.message),'health check reaches the (mock) Modrinth through the sandbox');
 ok(await call('PATCH','/api/plugins/modrinth-mods',{enabled:true}),'enable');
 const withSettings=ok(await call('PUT','/api/plugins/modrinth-mods/settings',{releaseChannel:'release',showClientOnly:false,pageSize:24,contact:'ops@example.org'}),'save settings');
 check(withSettings.settings.contact==='ops@example.org','settings are stored');
 status(await call('PUT','/api/plugins/modrinth-mods/settings',{releaseChannel:'nightly'}),400,'invalid select option');
 status(await call('PUT','/api/plugins/modrinth-mods/settings',{pageSize:500}),400,'number out of range');
 status(await call('PUT','/api/plugins/modrinth-mods/settings',{bogus:1}),400,'unknown setting');
 ok(await call('POST','/api/plugins',{source:'bundled',id:'modrinth-plugins',acceptPermissions:true}),'install modrinth-plugins');
 ok(await call('PATCH','/api/plugins/modrinth-plugins',{enabled:true}),'enable plugins browser');

 // --- A Fabric server on a node with a current agent ---------------------------------------
 const customer=ok(await call('POST','/api/customers',{email:'owner-'+randomBytes(3).toString('hex')+'@example.test'}),'customer');
 const other=ok(await call('POST','/api/customers',{email:'other-'+randomBytes(3).toString('hex')+'@example.test'}),'other customer');
 const node=await makeNode(admin,'alpha');
 await heartbeat(admin,node,'0.6.1.1');
 const server=ok(await call('POST','/api/servers',{name:'Fabric',ownerId:customer.id,templateId:'minecraft-fabric',nodeId:node.id,memoryMb:1024,cpuPercent:100,diskMb:4096,port:25565}),'create fabric server');
 const create=await nextJob(admin,node);check(create.kind==='create','create job is first');await finishJob(admin,node,create);
 const caps=ok(await call('GET',`/api/servers/${server.id}/addons`),'addons overview');
 check(caps.capability.supported&&caps.capability.kind==='mod'&&caps.capability.dir==='/mods'&&caps.capability.gameVersion==='1.21.11'&&caps.capability.loaders.join()==='fabric','capability comes from the template and variables');
 check(caps.providers.length===1&&caps.providers[0].pluginId==='modrinth-mods','only the mod browser serves a Fabric server');
 check(caps.agentOk===true,'agent is new enough');

 // --- Browsing ---------------------------------------------------------------------------
 const sid=server.id,A=`/api/servers/${sid}/addons`;
 const s1=ok(await call('GET',`${A}/search?pluginId=modrinth-mods`),'search');
 const titles=s1.items.map(i=>i.title).sort();
 check(JSON.stringify(titles)===JSON.stringify(['Fabric API','Lithium']),'client-only mods are hidden and loaders respected: '+titles);
 check(s1.items.every(i=>i.iconUrl&&i.iconUrl.startsWith('https://cdn.modrinth.com/')),'icon URLs survive the host allow-list');
 const s2=ok(await call('GET',`${A}/search?pluginId=modrinth-mods&showClientOnly=1`),'search with client-only');
 check(s2.items.some(i=>i.title==='Client Only Mod'),'client-only mods can be shown');
 check(ok(await call('GET',`${A}/search?pluginId=modrinth-mods&q=lith`),'search lith').items.length===1,'text search');
 const cats=ok(await call('GET',`${A}/categories?pluginId=modrinth-mods`),'categories');
 check(cats.map(c=>c.id).join()==='optimization,management','only server-relevant categories');
 const proj=ok(await call('GET',`${A}/project?pluginId=modrinth-mods&projectId=LITHIUM1`),'project');
 check(proj.title==='Lithium'&&proj.description.includes('fixture')&&proj.gallery.length===1&&proj.license==='MIT License','project details');
 const vers=ok(await call('GET',`${A}/versions?pluginId=modrinth-mods&projectId=LITHIUM1`),'versions');
 check(vers.map(v=>v.id).join()==='LITH-BETA,LITH-NEW,LITH-OLD','only versions for 1.21.11 + fabric, newest first: '+vers.map(v=>v.id));
 const wrongKind=await call('GET',`${A}/search?pluginId=modrinth-plugins`);status(wrongKind,404,'a plugin catalog is not offered for a mod server');
 const ua=mock.calls.find(c=>c.path==='/v2/search').ua;
 check(/^Fledge\/0\.6\.1\.1 \(https:\/\/github\.com\/kavaliersdelikt\/fledge; ops@example\.org\)$/.test(ua),'User-Agent identifies Fledge as Modrinth asks: '+ua);

 // --- Plan and install ------------------------------------------------------------------------
 const plan=ok(await call('POST',`${A}/plan`,{pluginId:'modrinth-mods',projectId:'LITHIUM1'}),'plan');
 const main=plan.items.find(i=>i.role==='main'),dep=plan.items.find(i=>i.role==='required'),opt=plan.items.find(i=>i.role==='optional');
 check(main.versionId==='LITH-NEW'&&main.channel==='release','the newest stable version is chosen, not the beta');
 check(dep&&dep.projectId==='FABAPI01'&&dep.file.filename==='fabric-api-0.100.0+1.21.11.jar','required dependency is resolved');
 check(opt&&opt.projectId==='CLIENTMD'&&opt.title==='Client Only Mod'&&!opt.selected,'optional dependency is suggested, not selected');
 check(plan.blockers.length===0,'no blockers');
 status(await call('POST',`${A}/plan`,{pluginId:'modrinth-mods',projectId:'LITHIUM1',versionId:'LITH-120'}),502,'a version for another Minecraft version is refused');
 const inst=ok(await call('POST',`${A}/install`,{pluginId:'modrinth-mods',projectId:'LITHIUM1'}),'install');
 check(inst.addons.length===2&&inst.restartRequired,'two files queued');
 // Jobs are leased one at a time per server, so finish the first before the second is offered.
 const first=await nextJob(admin,node);check(first&&first.kind==='file.fetch','a file.fetch job is queued');
 check(first.payload.allowedHosts.some(h=>h.toLowerCase()==='cdn.modrinth.com')&&first.payload.allowedHosts.every(h=>{const host=h.toLowerCase();return host==='modrinth.com'||host.endsWith('.modrinth.com');}),'the node may only download from the declared hosts');
 check(first.payload.sha512.length===128&&first.payload.size>0&&first.payload.path.startsWith('/mods/'),'job carries path, size and SHA-512');
 await finishJob(admin,node,first,true,{ok:true,sizeBytes:first.payload.size});
 const second=await nextJob(admin,node);check(second&&second.kind==='file.fetch','second file follows the first');
 await finishJob(admin,node,second,true,{ok:true,sizeBytes:second.payload.size});
 const list1=ok(await call('GET',A),'addons after install');
 check(list1.installed.length===2&&list1.installed.every(a=>a.state==='installed'),'both add-ons are installed after the node confirms');
 const lith=list1.installed.find(a=>a.projectId==='LITHIUM1');check(lith.filename==='lithium-fabric-0.21.4+mc1.21.11.jar'&&lith.versionLabel==='0.21.4'&&!lith.isDependency,'main add-on recorded');
 check(list1.installed.find(a=>a.projectId==='FABAPI01').isDependency,'dependency is flagged as such');
 const s3=ok(await call('GET',`${A}/search?pluginId=modrinth-mods&q=lith`),'search after install');
 check(s3.items[0].installedAddonId===lith.id&&s3.items[0].installedVersion==='0.21.4','search marks installed add-ons');
 status(await call('POST',`${A}/install`,{pluginId:'modrinth-mods',projectId:'LITHIUM1'}),409,'installing the same project twice');

 // --- Updates -------------------------------------------------------------------------------------
 const up0=ok(await call('GET',`${A}/updates?refresh=1`),'updates');check(up0.updates.length===0,'no update while on the newest stable build');
 ok(await call('PUT','/api/plugins/modrinth-mods/settings',{releaseChannel:'beta',showClientOnly:false,pageSize:24,contact:'ops@example.org'}),'switch to the beta channel');
 const up1=ok(await call('GET',`${A}/updates?refresh=1`),'updates on beta channel');
 check(up1.updates.length===1&&up1.updates[0].latest.id==='LITH-BETA'&&up1.updates[0].title==='Lithium','a beta update appears when the channel allows it');
 ok(await call('PATCH',`${A}/${lith.id}`,{pinned:true}),'pin');
 const skipPinned=ok(await call('POST',`${A}/update`,{}),'update all skips pinned');check(skipPinned.queued.length===0,'pinned add-ons are not updated in bulk');
 ok(await call('PATCH',`${A}/${lith.id}`,{pinned:false}),'unpin');
 const upd=ok(await call('POST',`${A}/update`,{addonIds:[lith.id]}),'update one');
 check(upd.queued.length===1&&upd.queued[0].to==='0.22.0-beta.1','update queued');
 const uj=await nextJob(admin,node);
 check(uj.kind==='file.fetch'&&uj.payload.update&&uj.payload.replace.join()==='/mods/lithium-fabric-0.21.4+mc1.21.11.jar'&&uj.payload.path==='/mods/lithium-fabric-0.22.0-beta.1+mc1.21.11.jar','update downloads first and replaces the old file only after success');
 await finishJob(admin,node,uj,false,{},'checksum mismatch');
 const afterFail=ok(await call('GET',A),'after failed update').installed.find(a=>a.id===lith.id);
 check(afterFail.state==='installed'&&afterFail.versionLabel==='0.21.4'&&/Update failed/.test(afterFail.error),'a failed update leaves the working version in place');
 const upd2=ok(await call('POST',`${A}/update`,{addonIds:[lith.id]}),'retry update');check(upd2.queued.length===1,'retry queued');
 status(await call('PATCH',`${A}/${lith.id}`,{disabled:true}),409,'an add-on with an update in flight cannot be renamed');
 status(await call('DELETE',`${A}/${lith.id}`),409,'or removed');
 const uj2=await nextJob(admin,node);await finishJob(admin,node,uj2,true,{ok:true,sizeBytes:uj2.payload.size});
 const afterOk=ok(await call('GET',A),'after update').installed.find(a=>a.id===lith.id);
 check(afterOk.versionLabel==='0.22.0-beta.1'&&afterOk.filename==='lithium-fabric-0.22.0-beta.1+mc1.21.11.jar'&&!afterOk.error,'record follows the update');
 ok(await call('PUT','/api/plugins/modrinth-mods/settings',{releaseChannel:'release',showClientOnly:false,pageSize:24,contact:'ops@example.org'}),'back to stable');

 // --- Disable, enable, remove ----------------------------------------------------------------------
 ok(await call('PATCH',`${A}/${lith.id}`,{disabled:true}),'disable');
 const dj=await nextJob(admin,node);
 check(dj.kind==='file.rename'&&dj.payload.from==='/mods/lithium-fabric-0.22.0-beta.1+mc1.21.11.jar'&&dj.payload.to===dj.payload.from+'.disabled','disable renames the jar');
 await finishJob(admin,node,dj);
 check(ok(await call('GET',A),'listed').installed.find(a=>a.id===lith.id).disabled===true,'disabled state recorded after the node confirms');
 ok(await call('PATCH',`${A}/${lith.id}`,{disabled:false}),'enable');
 const ej=await nextJob(admin,node);check(ej.payload.to===ej.payload.from.replace(/\.disabled$/,'')&&ej.payload.disabled===false,'enable renames back');await finishJob(admin,node,ej);
 ok(await call('DELETE',`${A}/${lith.id}`),'remove');
 const rj=await nextJob(admin,node);check(rj.kind==='file.delete'&&rj.payload.paths.join()==='/mods/lithium-fabric-0.22.0-beta.1+mc1.21.11.jar','remove deletes exactly the tracked file');
 status(await call('DELETE',`${A}/${lith.id}`),409,'remove twice while pending');
 await finishJob(admin,node,rj);
 check(ok(await call('GET',A),'listed').installed.every(a=>a.id!==lith.id),'removed add-on is gone from the list');

 // --- Failed install is recorded and can be retried ----------------------------------------------
 ok(await call('POST',`${A}/install`,{pluginId:'modrinth-mods',projectId:'LITHIUM1'}),'reinstall after removal');
 const fj=await nextJob(admin,node);await finishJob(admin,node,fj,false,{},'download failed: 503');
 const fl=ok(await call('GET',A),'listed');const bad=fl.installed.find(a=>a.projectId==='LITHIUM1');
 check(bad.state==='failed'&&/503/.test(bad.error),'failed installs show their error');
 const again=ok(await call('POST',`${A}/install`,{pluginId:'modrinth-mods',projectId:'LITHIUM1'}),'retry a failed install');
 const rj2=await nextJob(admin,node);await finishJob(admin,node,rj2,true,{ok:true,sizeBytes:rj2.payload.size});
 check(again.addons.length===1,'the retry replaces the failed record');
 ok(await call('DELETE',`${A}/${fl.installed.find(a=>a.projectId==='FABAPI01').id}`),'remove dependency');
 const dj3=await nextJob(admin,node);await finishJob(admin,node,dj3);

 // --- Access control -----------------------------------------------------------------------------
 const owner=client(stack.base);
 // temporary passwords are only returned when none is supplied
 const ownerLogin=ok(await call('POST','/api/customers',{email:'o2-'+randomBytes(3).toString('hex')+'@example.test',password:'a-long-owner-password-1'}),'second customer');
 void ownerLogin;
 const outsider=client(stack.base);
 ok(await outsider.call('POST','/api/auth/login',{email:other.email,password:other.temporaryPassword}),'outsider login');
 status(await outsider.call('GET',A),404,'a customer without access to the server cannot see its add-ons');
 status(await outsider.call('GET','/api/plugins'),403,'customers cannot see the plugin list');
 status(await outsider.call('POST','/api/plugins',{source:'bundled',id:'modrinth-plugins',acceptPermissions:true}),403,'customers cannot install plugins');
 const ownerSession=client(stack.base);
 ok(await ownerSession.call('POST','/api/auth/login',{email:customer.email,password:customer.temporaryPassword}),'owner login');
 ok(await ownerSession.call('GET',A),'the owner can use add-ons');
 check(ok(await ownerSession.call('GET',`${A}/search?pluginId=modrinth-mods`),'owner search').items.length>0,'the owner can search');
 ok(await call('POST',`/api/servers/${sid}/collaborators`,{email:other.email,permissions:['console']}),'console-only collaborator');
 status(await outsider.call('GET',A),404,'a collaborator without the files permission cannot manage add-ons');
 ok(await call('POST',`/api/servers/${sid}/collaborators`,{email:other.email,permissions:['files']}),'files collaborator');
 ok(await outsider.call('GET',A),'a collaborator with the files permission can');
 void owner;

 // --- Old agent -------------------------------------------------------------------------------------
 await heartbeat(admin,node,'0.5.2.1');
 const old=ok(await call('GET',A),'overview with an old agent');check(old.agentOk===false,'old agents are flagged');
 status(await call('POST',`${A}/install`,{pluginId:'modrinth-mods',projectId:'LITHIUM1'}),409,'old agents cannot take add-on jobs');
 await heartbeat(admin,node,'0.6.1.1');

 // --- A Paper server uses the plugin browser ------------------------------------------------------------
 const paper=ok(await call('POST','/api/servers',{name:'Paper',ownerId:customer.id,templateId:'minecraft-paper',nodeId:node.id,memoryMb:1024,cpuPercent:100,diskMb:4096,port:25570}),'paper server');
 const pc=await nextJob(admin,node);await finishJob(admin,node,pc);
 const PA=`/api/servers/${paper.id}/addons`;
 const pcaps=ok(await call('GET',PA),'paper overview');
 check(pcaps.capability.kind==='plugin'&&pcaps.capability.dir==='/plugins'&&pcaps.capability.loaders.join()==='paper,spigot,bukkit'&&pcaps.providers[0].pluginId==='modrinth-plugins','Paper uses the plugin browser with Paper loaders');
 const ps=ok(await call('GET',`${PA}/search?pluginId=modrinth-plugins`),'plugin search');
 check(ps.items.map(i=>i.title).sort().join()==='LuckPerms,Vault','Folia-only plugins are not offered to Paper: '+ps.items.map(i=>i.title));
 const pplan=ok(await call('POST',`${PA}/plan`,{pluginId:'modrinth-plugins',projectId:'LUCKPERM'}),'plugin plan');
 check(pplan.items.find(i=>i.role==='main').file.filename==='LuckPerms-Bukkit-5.4.0.jar'&&pplan.items.some(i=>i.role==='optional'&&i.projectId==='VAULT001'&&i.title==='Vault'),'LuckPerms resolves to the Bukkit build and suggests Vault');
 const pinst=ok(await call('POST',`${PA}/install`,{pluginId:'modrinth-plugins',projectId:'LUCKPERM',optional:['VAULT001']}),'install plugin with optional dependency');
 check(pinst.addons.length===2,'optional dependency installed on request');
 for(let i=0;i<2;i++){const j=await nextJob(admin,node);check(j.payload.path.startsWith('/plugins/'),'plugins go to /plugins');await finishJob(admin,node,j,true,{ok:true,sizeBytes:j.payload.size});}

 // --- Folia gets Folia builds -----------------------------------------------------------------------------
 const folia=ok(await call('POST','/api/servers',{name:'Folia',ownerId:customer.id,templateId:'minecraft-folia',nodeId:node.id,memoryMb:1024,cpuPercent:100,diskMb:4096,port:25575}),'folia server');
 const fc=await nextJob(admin,node);await finishJob(admin,node,fc);
 const fs=ok(await call('GET',`/api/servers/${folia.id}/addons/search?pluginId=modrinth-plugins`),'folia search');
 check(fs.items.map(i=>i.title).sort().join()==='Folia Only Plugin,LuckPerms','Folia servers only see Folia-compatible plugins: '+fs.items.map(i=>i.title));
 const fplan=ok(await call('POST',`/api/servers/${folia.id}/addons/plan`,{pluginId:'modrinth-plugins',projectId:'LUCKPERM'}),'folia plan');
 check(fplan.items.find(i=>i.role==='main').file.filename==='LuckPerms-Folia-5.4.0.jar','Folia picks the Folia build');

 // --- Server type without add-ons / unknown type -------------------------------------------------------------
 const vanilla=ok(await call('POST','/api/servers',{name:'Vanilla',ownerId:customer.id,templateId:'minecraft-java',nodeId:node.id,memoryMb:1024,cpuPercent:100,diskMb:4096,port:25580}),'vanilla server');
 const vj=await nextJob(admin,node);await finishJob(admin,node,vj);
 const vc=ok(await call('GET',`/api/servers/${vanilla.id}/addons`),'vanilla overview');
 check(vc.capability.supported===false&&/do not load mods or plugins/.test(vc.capability.reason),'vanilla servers explain why add-ons are unavailable');
 const valheim=ok(await call('POST','/api/servers',{name:'Val',ownerId:customer.id,templateId:'valheim',nodeId:node.id,memoryMb:1024,cpuPercent:100,diskMb:4096,port:2456}),'valheim');
 const vv=ok(await call('GET',`/api/servers/${valheim.id}/addons`),'valheim overview');check(vv.capability.supported===false,'other games have no add-ons');
 status(await call('GET',`/api/servers/${valheim.id}/addons/search`),404,'no catalog for unsupported servers');

 // --- Server variables change what is offered ----------------------------------------------------------------
 // The generic Java template supports several server types through its TYPE variable.
 ok(await call('PATCH',`/api/servers/${vanilla.id}/settings`,{variables:{TYPE:'PAPER'}}),'switch to Paper');
 const vj2=await nextJob(admin,node);await finishJob(admin,node,vj2);
 const vc2=ok(await call('GET',`/api/servers/${vanilla.id}/addons`),'overview after switching type');
 check(vc2.capability.supported&&vc2.capability.kind==='plugin','changing TYPE enables plugin add-ons');

 // --- Plugin lifecycle ----------------------------------------------------------------------------------------
 ok(await call('PATCH','/api/plugins/modrinth-mods',{enabled:false}),'disable plugin');
 status(await call('GET',`${A}/search?pluginId=modrinth-mods`),404,'a disabled plugin serves no catalog');
 const stillThere=ok(await call('GET',A),'installed list works without the plugin');check(stillThere.installed.length>=1&&stillThere.providers.length===0,'tracked add-ons stay visible when the plugin is off');
 ok(await call('PATCH','/api/plugins/modrinth-mods',{enabled:true}),'enable again');
 const logs=ok(await call('GET','/api/plugins/modrinth-mods/logs'),'logs');check(Array.isArray(logs),'plugin logs endpoint');
 ok(await call('DELETE','/api/plugins/modrinth-mods'),'uninstall');
 check(ok(await call('GET',A),'after uninstall').installed.length>=1,'files installed by a removed plugin stay tracked (orphaned)');
 const audit=ok(await call('GET','/api/activity?limit=100'),'activity');
 for(const action of ['plugin.install','plugin.enable','plugin.settings','plugin.uninstall','addon.install','addon.update','addon.remove'])check(audit.some(a=>a.action===action),'audit trail has '+action);
 const rows=await dbQuery(stack.databaseUrl,"SELECT count(*)::int AS n FROM plugins WHERE id='modrinth-mods'");check(rows[0].n===0,'plugin row is gone');
 console.log(`PASS ${admin.state.count} assertions: plugin host, store, install/consent, settings, Modrinth browsing, dependency planning, install/update/rollback-safe jobs, disable/remove, access control, loaders per server type, lifecycle`);
 void adminLogin;
}catch(e){failed=e;}
finally{
 await mock.close();
 if(failed){console.error('FAIL',failed.message);console.error('--- api log tail ---\n'+stack.api.logs().split('\n').slice(-25).join('\n'));console.error('--- host log tail ---\n'+stack.host.logs().split('\n').slice(-10).join('\n'));}
 await stack.stop();
 process.exit(failed?1:0);
}
