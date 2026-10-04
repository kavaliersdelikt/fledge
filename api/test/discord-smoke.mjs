// Notification styles: the "Better Discord Notifications" plugin, channel styles, fallbacks.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {bootStack,client,bootstrapAdmin} from './harness.mjs';

const received=[];
const hook=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{received.push({url:req.url,body:JSON.parse(raw||'{}')});res.statusCode=200;res.end('ok');});});
await new Promise(r=>hook.listen(0,'127.0.0.1',r));
const hookUrl=`http://127.0.0.1:${hook.address().port}`;

const stack=await bootStack({db:'fledge_discord_smoke',apiPort:4182,hostPort:4530,mock:null});
const admin=client(stack.base);const {call,ok,status,check}=admin;
let failed=null;
const last=path=>[...received].reverse().find(r=>r.url===path);
try{
 await bootstrapAdmin(admin);
 const customer=ok(await call('POST','/api/customers',{email:'c-'+randomBytes(3).toString('hex')+'@example.test'}),'customer');
 const cust=client(stack.base);ok(await cust.call('POST','/api/auth/login',{email:customer.email,password:customer.temporaryPassword}),'customer login');

 // --- Without the plugin: plain text only ---------------------------------------------------------------------------
 check(JSON.stringify(ok(await call('GET','/api/notification-styles'),'styles').discord.map(s=>s.id))==='["plain"]','only the plain style exists until a formatter plugin is on');
 status(await call('POST','/api/notification-channels',{name:'Rich',kind:'discord',events:['server.crashed'],url:hookUrl+'/d1',style:'embed'}),409,'a style from a plugin that is not installed is refused');
 status(await call('POST','/api/notification-channels',{name:'Rich',kind:'discord',events:['server.crashed'],url:hookUrl+'/d1',style:'<script>'}),400,'a malformed style is refused');
 status(await call('POST','/api/notification-channels',{name:'Rich',kind:'slack',events:['server.crashed'],url:hookUrl+'/s1',style:'embed'}),400,'styles are only for Discord channels');
 const plain=ok(await call('POST','/api/notification-channels',{name:'Plain',kind:'discord',events:['server.crashed'],url:hookUrl+'/d1'}),'a Discord channel without a style');
 check(plain.style==='plain','a channel without a style is plain');
 ok(await call('POST',`/api/notification-channels/${plain.id}/test`,{}),'test (plain)');
 const p0=last('/d1').body;
 check(p0.content&&/Test notification/.test(p0.content)&&!p0.embeds&&JSON.stringify(p0.allowed_mentions)==='{"parse":[]}','the plain message is one line and cannot mention anyone');

 // --- Install the plugin ----------------------------------------------------------------------------------------------
 const store=ok(await call('GET','/api/plugins/store'),'store');
 check((store.items||store).some(p=>p.id==='discord-embeds'),'the plugin is offered in the store');
 status(await call('POST','/api/plugins',{source:'bundled',id:'discord-embeds'}),400,'install needs the permission to be accepted');
 const inst=ok(await call('POST','/api/plugins',{source:'bundled',id:'discord-embeds',acceptPermissions:true}),'install');
 check(inst.notifications&&inst.notifications.channel==='discord'&&inst.notifications.styles.length===2,'the plugin declares its styles');
 check(!JSON.stringify(inst.permissions).includes('network:'),'the formatter has no network access');
 ok(await call('PATCH','/api/plugins/discord-embeds',{enabled:true}),'enable');
 check(JSON.stringify(ok(await call('GET','/api/notification-styles'),'styles').discord.map(s=>s.id))==='["plain","embed","compact"]','the plugin adds its styles');
 check(JSON.stringify((ok(await cust.call('GET','/api/notification-styles'),'customer styles')).discord.map(s=>s.id))==='["plain","embed","compact"]','customers see them too');

 // --- Administrator channel with the rich style -------------------------------------------------------------------
 const rich=ok(await call('POST','/api/notification-channels',{name:'Rich',kind:'discord',events:['server.crashed'],url:hookUrl+'/d2',style:'embed'}),'rich channel');
 check(rich.style==='embed'&&!JSON.stringify(rich).includes('/d2'),'the style is shown, the address still is not');
 ok(await call('POST',`/api/notification-channels/${rich.id}/test`,{}),'test (rich)');
 const b=last('/d2').body,e=b.embeds&&b.embeds[0];
 check(e&&/Test notification/.test(e.title)&&Number.isInteger(e.color)&&e.footer&&/test/.test(e.footer.text)&&Array.isArray(e.fields)&&e.fields.length>=1,'the test message is a colour-coded embed with fields and a footer');
 check(JSON.stringify(b.allowed_mentions)==='{"parse":[]}'&&!b.content,'no mentions and no stray content in the embed message');
 check(/^https?:\/\//.test(e.url||'http://x'),'a link is a plain http(s) address');

 // A role ping is possible on the administrator's channel only, and only for the chosen severity.
 ok(await call('PUT','/api/plugins/discord-embeds/settings',{botName:'Ops bot',pingRoleId:'123456789012345678',pingWhen:'warn',colorInfo:'#00ff00',showEventCode:true}),'plugin settings');
 ok(await call('POST',`/api/notification-channels/${rich.id}/test`,{}),'test again');
 const b2=last('/d2').body;
 check(b2.username==='Ops bot'&&b2.embeds[0].color===0x00ff00&&!b2.content,'sender name and colour settings apply; an information message does not ping');
 status(await call('PUT','/api/plugins/discord-embeds/settings',{pingRoleId:'@everyone'}),400,'a role must be a numeric id');
 status(await call('PUT','/api/plugins/discord-embeds/settings',{colorBad:'red'}),400,'a colour must be six hex digits');

 // --- Compact style, and switching styles -----------------------------------------------------------------------------
 ok(await call('PATCH',`/api/notification-channels/${rich.id}`,{style:'compact'}),'switch to compact');
 ok(await call('POST',`/api/notification-channels/${rich.id}/test`,{}),'test compact');
 const c=last('/d2').body.embeds[0];
 check(c.description&&/Test notification/.test(c.description)&&!c.fields,'the compact embed is a single description');
 ok(await call('PATCH',`/api/notification-channels/${rich.id}`,{name:'Renamed'}),'rename keeps the style');
 check(ok(await call('GET','/api/notification-channels'),'channels').find(x=>x.id===rich.id).style==='compact','editing something else keeps the style');
 ok(await call('PATCH',`/api/notification-channels/${rich.id}`,{url:hookUrl+'/d3'}),'new address keeps the style');
 ok(await call('POST',`/api/notification-channels/${rich.id}/test`,{}),'test new address');
 check(last('/d3').body.embeds,'still compact after the address changed');

 // --- A customer chooses a style for their own channel -------------------------------------------------------
 const mine=ok(await cust.call('POST','/api/notification-channels',{name:'Mine',kind:'discord',events:['server.crashed'],url:'https://discord.com/api/webhooks/1/abc',style:'compact'}),'customer channel');
 check(mine.style==='compact'&&mine.scope==='user','customers can choose a style for their own Discord channel');
 cust.status(await cust.call('PATCH',`/api/notification-channels/${mine.id}`,{style:'nope'}),409,'an unknown style is refused for customers too');

 // --- If the plugin goes away the message still arrives, plain ---------------------------------------------------
 ok(await call('PATCH','/api/plugins/discord-embeds',{enabled:false}),'disable the plugin');
 check(JSON.stringify(ok(await call('GET','/api/notification-styles'),'styles').discord.map(s=>s.id))==='["plain"]','styles disappear with the plugin');
 ok(await call('POST',`/api/notification-channels/${rich.id}/test`,{}),'test with the plugin off');
 const fb=last('/d3').body;
 check(fb.content&&/Test notification/.test(fb.content)&&!fb.embeds,'a channel set to a style falls back to the plain message when the plugin is off');
 check(ok(await call('GET','/api/notification-channels'),'channels').find(x=>x.id===rich.id).style==='compact','the channel keeps its style for when the plugin returns');
 console.log(`PASS ${admin.state.count+cust.state.count} assertions: styles list, plugin install, rich and compact embeds, settings (name, colour, role ping), customers, fallback to plain, mention safety`);
}catch(e){failed=e;}
finally{
 hook.close();
 if(failed){console.error('FAIL',failed.message);console.error('--- api log tail ---\n'+stack.api.logs().split('\n').slice(-20).join('\n'));}
 await stack.stop();process.exit(failed?1:0);
}
