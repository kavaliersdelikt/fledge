import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {cleanDiscord} from '../src/notification-styles.ts';
import {validateManifest,ManifestError} from '../src/plugins/manifest.ts';

const dir=fileURLToPath(new URL('../../plugins/bundled/discord-embeds/',import.meta.url));
const code=readFileSync(dir+'plugin.js','utf8');
const manifest=JSON.parse(readFileSync(dir+'fledge-plugin.json','utf8'));
const load=(settings:Record<string,unknown>={})=>{
 const g:any={host:{settings}};g.globalThis=g;
 runInNewContext(code,g);
 return (input:any)=>g.fledgePlugin.formatNotification(input) as any;
};
const base={style:'embed',scope:'panel',brand:'Willow',panelUrl:'https://panel.example',
 event:{kind:'server.crashed',severity:'bad',title:'Survival crashed',body:'exit code 137, out of memory\n\nline one\nline two',server:{id:'abc',name:'Survival'},nodeId:null,at:'2026-10-04T10:00:00.000Z',data:{exit:{code:137,oomKilled:true},jobId:'j1',players:12,dedupe:'x'}}};

test('the manifest is valid and asks for nothing but the notifications permission',()=>{
 const m=validateManifest(manifest);
 assert.deepEqual(m.permissions,['notifications']);
 assert.equal(m.notifications?.channel,'discord');
 assert.deepEqual(m.notifications?.styles.map(s=>s.id),['embed','compact']);
});
test('manifest: the capability and the permission go together',()=>{
 assert.throws(()=>validateManifest({...manifest,permissions:[]}),ManifestError);
 const {notifications,...without}=manifest;void notifications;
 assert.throws(()=>validateManifest(without),ManifestError);
 assert.throws(()=>validateManifest({...manifest,notifications:{channel:'discord',styles:[{id:'plain',label:'x'}]}}),ManifestError);
 assert.throws(()=>validateManifest({...manifest,notifications:{channel:'slack',styles:[{id:'a',label:'x'}]}}),ManifestError);
});

test('a crash becomes a colour-coded embed with the cause, a link and the last output',()=>{
 const out=cleanDiscord(load()(base),'panel')!;
 const e=(out.embeds as any[])[0];
 assert.match(e.title,/Survival crashed/);
 assert.equal(e.color,0xed4245);
 assert.equal(e.url,'https://panel.example/servers/abc');
 assert.equal(e.description,'exit code 137, out of memory');
 const names=e.fields.map((f:any)=>f.name);
 assert.ok(names.includes('Server')&&names.includes('Exit code')&&names.includes('Cause')&&names.includes('Last output'));
 assert.ok(e.fields.find((f:any)=>f.name==='Last output').value.includes('line two'));
 assert.ok(e.fields.some((f:any)=>f.name==='Players'&&f.value==='12'),'simple facts from the data appear');
 assert.ok(!e.fields.some((f:any)=>/job|dedupe/i.test(f.name)),'internal ids are left out');
 assert.match(e.footer.text,/server\.crashed/);
 assert.equal(e.timestamp,'2026-10-04T10:00:00.000Z');
 assert.deepEqual(out.allowed_mentions,{parse:[]});
});

test('settings: no log tail, no links, no emoji, own colours',()=>{
 const out=cleanDiscord(load({showLogTail:false,showLinks:false,showEmoji:false,showTimestamp:false,colorBad:'#00ff00',showEventCode:false})(base),'panel')!;
 const e=(out.embeds as any[])[0];
 assert.ok(!e.fields.some((f:any)=>f.name==='Last output'));
 assert.equal(e.url,undefined);assert.equal(e.timestamp,undefined);assert.equal(e.color,0x00ff00);
 assert.ok(!/[\uD800-\uDFFF]/.test(e.title),'no emoji');
 assert.equal(e.footer.text,'Willow');
});

test('compact style is one description and no fields',()=>{
 const e=(cleanDiscord(load()({...base,style:'compact'}),'panel')!.embeds as any[])[0];
 assert.ok(e.description.includes('Survival crashed'));assert.equal(e.fields,undefined);
});

test('role ping: only on the administrator channel, only for the chosen severity, only a numeric id',()=>{
 const send=load({pingRoleId:'123456789012345678',pingWhen:'bad'});
 const admin=cleanDiscord(send(base),'panel')!;
 assert.equal(admin.content,'<@&123456789012345678>');
 assert.deepEqual(admin.allowed_mentions,{parse:[],roles:['123456789012345678']});
 const customer=cleanDiscord(send({...base,scope:'user'}),'user')!;
 assert.deepEqual(customer.allowed_mentions,{parse:[]});
 const info=cleanDiscord(send({...base,event:{...base.event,severity:'info'}}),'panel')!;
 assert.equal(info.content,undefined);
 assert.equal(cleanDiscord(load({pingRoleId:'@everyone',pingWhen:'bad'})(base),'panel')!.content,undefined);
});

test('hostile text never pings: @everyone in a server name stays text',()=>{
 const out=cleanDiscord(load()({...base,event:{...base.event,title:'@everyone is down',server:{id:'a',name:'@here <@&1> <@2>'}}}),'panel')!;
 assert.deepEqual(out.allowed_mentions,{parse:[]});
});

test('cleanDiscord rebuilds the body from an allow-list and Discord limits',()=>{
 const out=cleanDiscord({
  content:'x'.repeat(5000),username:'u'.repeat(200),avatar_url:'http://insecure.example/a.png',tts:true,flags:4,components:[{type:1}],
  allowed_mentions:{parse:['everyone','users'],roles:['123456789012345678','nope','1'],users:['1']},
  embeds:[{title:'t'.repeat(400),description:'d'.repeat(6000),url:'javascript:alert(1)',color:-5,image:{url:'https://x/y.png'},
   thumbnail:{url:'http://x/y.png'},author:{name:'a',url:'ftp://x'},footer:{text:'f',icon_url:'http://x'},
   fields:[...Array.from({length:40},(_,i)=>({name:'n'+i,value:'v'.repeat(2000)})),{name:'',value:'empty name'}]},'junk',null]},'user')!;
 assert.equal((out.content as string).length,2000);
 assert.equal((out.username as string).length,80);
 assert.equal(out.avatar_url,undefined);
 assert.equal(out.tts,undefined);assert.equal(out.flags,undefined);assert.equal(out.components,undefined);
 assert.deepEqual(out.allowed_mentions,{parse:[]},'customers can never mention roles');
 const e=(out.embeds as any[])[0];
 assert.equal(e.title.length,256);assert.ok(e.description.length<=4096);
 assert.equal(e.url,undefined);assert.equal(e.color,undefined);assert.equal(e.image,undefined);assert.equal(e.thumbnail,undefined);
 assert.equal(e.author.url,undefined);assert.equal(e.footer.icon_url,undefined);
 assert.ok(e.fields.length<=25&&e.fields.every((f:any)=>f.value.length<=1024&&f.name));
 const total=JSON.stringify(e).length;assert.ok(total<7000);
 const admin=cleanDiscord({content:'hi',allowed_mentions:{roles:['123456789012345678','123456789012345679','123456789012345680','123456789012345681']}},'panel')!;
 assert.equal((admin.allowed_mentions as any).roles.length,3,'at most three roles');
});
test('cleanDiscord refuses empty or malformed results',()=>{
 for(const bad of [null,undefined,'x',5,[],{},{embeds:[]},{embeds:['x']},{username:'only'}])assert.equal(cleanDiscord(bad,'panel'),null);
});
