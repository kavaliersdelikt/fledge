import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateManifest,validateSettings,permissionProblem,describePermission,ManifestError,networkHosts} from '../src/plugins/manifest.ts';
import {validCidr,ipAllowed} from '../src/cidr.ts';
import {quotaProblem,validateQuota} from '../src/quota.ts';
import {effectiveDefs,checkValue,validateDefs} from '../src/templates.ts';
import {cronNext,checkCron,validateTasks,tasksOf} from '../src/automation.ts';
import {capabilityFor} from '../src/addons.ts';
import {normalizePolicy,validatePolicy} from '../src/crash.ts';
import {payloadFor,EVENTS} from '../src/notifications.ts';
import {isPrivateAddress} from '../src/netguard.ts';
import {safeTest,validPattern} from '../src/saferegex.ts';
import {tokenScopeFor} from '../src/openapi.ts';
import {checkTotp,looksLikeEmail,looksLikeMailbox} from '../src/core.ts';
import {authenticator} from 'otplib';

const base={id:'demo-plugin',name:'Demo',version:'1.0.0',apiVersion:1,description:'d',author:'a',license:'MIT'};
test('TOTP verification tolerates one adjacent time step only',()=>{
 const realNow=Date.now,now=Math.floor(realNow()/30_000)*30_000+1_000,secret=authenticator.generateSecret();
 const codeAt=(epoch:number)=>authenticator.clone({epoch}).generate(secret);
 Date.now=()=>now;
 try{
  assert.equal(checkTotp(secret,codeAt(now-30_000)),true,'a code from the immediately preceding time step is accepted');
  assert.equal(checkTotp(secret,codeAt(now-60_000)),false,'older codes remain invalid');
  assert.equal(checkTotp(secret,'not-a-code'),false,'malformed codes remain invalid');
 }finally{Date.now=realNow;}
});
test('manifest validation accepts good manifests and explains bad ones',()=>{
 const m=validateManifest({...base,permissions:['network:api.example.com','servers:read','storage'],catalogs:[{id:'c',label:'C',kind:'mod'}]});
 assert.deepEqual(networkHosts(m.permissions),['api.example.com']);
 const problems=(x:any)=>{try{validateManifest(x);return [];}catch(e:any){assert.ok(e instanceof ManifestError);return e.problems;}};
 assert.ok(problems({...base,id:'Bad'}).some(p=>/id/.test(p)));
 assert.ok(problems({...base,version:'one'}).some(p=>/version/.test(p)));
 assert.ok(problems({...base,apiVersion:2}).some(p=>/apiVersion/.test(p)));
 assert.ok(problems({...base,permissions:['fs:write']}).some(p=>/unknown permission/.test(p)));
 assert.ok(problems({...base,hooks:['server.created']}).some(p=>/hooks/.test(p)));
 assert.ok(problems({...base,catalogs:[{id:'c',label:'C',kind:'mod'}]}).some(p=>/servers:read/.test(p)));
 assert.ok(problems(null).length);
 assert.ok(problems({...base,settings:[{key:'a',label:'A',type:'select'}]}).some(p=>/options/.test(p)));
 assert.ok(problems({...base,settings:[{key:'a',label:'A',type:'string'},{key:'a',label:'A',type:'string'}]}).some(p=>/twice/.test(p)));
});
test('network permissions only allow real public-looking host names',()=>{
 for(const bad of ['network:127.0.0.1','network:localhost','network:intranet.local','network:10.1.1.1','network:*.com','network:a','network:','network:evil.internal','network:foo bar.com'])assert.ok(permissionProblem(bad),bad);
 for(const good of ['network:api.modrinth.com','network:*.modrinth.com','servers:read','servers:files.write','storage','hooks'])assert.equal(permissionProblem(good),null,good);
 assert.match(describePermission('network:cdn.modrinth.com'),/Connect to cdn\.modrinth\.com/);
});
test('plugin settings are validated and secrets keep their stored value',()=>{
 const fields:any[]=[{key:'name',label:'Name',type:'string',default:'x',pattern:'^[a-z]+$'},{key:'n',label:'N',type:'number',min:1,max:10},{key:'on',label:'On',type:'boolean',default:true},{key:'mode',label:'Mode',type:'select',options:[{value:'a',label:'A'},{value:'b',label:'B'}],default:'a'},{key:'token',label:'Token',type:'secret',required:true}];
 const r=validateSettings(fields,{n:'5',token:'t'},{});
 assert.deepEqual(r.values,{name:'x',n:5,on:true,mode:'a'});assert.deepEqual(r.secrets,{token:'t'});
 assert.deepEqual(validateSettings(fields,{n:5},{token:'old'}).secrets,{token:'old'},'omitted secrets are kept');
 assert.throws(()=>validateSettings(fields,{n:5},{}),/Token is required/);
 assert.throws(()=>validateSettings(fields,{n:11,token:'t'},{}),/between/);
 assert.throws(()=>validateSettings(fields,{name:'UPPER',token:'t'},{}),/invalid format/);
 assert.throws(()=>validateSettings(fields,{mode:'c',token:'t'},{}),/listed options/);
 assert.throws(()=>validateSettings(fields,{bogus:1,token:'t'},{}),/not a setting/);
});
test('CIDR allow-lists',()=>{
 assert.equal(validCidr('10.0.0.0/8'),true);assert.equal(validCidr('2001:db8::/32'),true);assert.equal(validCidr('1.2.3.4'),true);
 for(const bad of ['10.0.0.0/33','1.2.3','x','10.0.0.0/8/9','::1/129','1.2.3.4/ 8'])assert.equal(validCidr(bad),false,bad);
 assert.equal(ipAllowed('10.1.2.3',['10.0.0.0/8']),true);assert.equal(ipAllowed('11.1.2.3',['10.0.0.0/8']),false);
 assert.equal(ipAllowed('::ffff:10.1.2.3',['10.0.0.0/8']),true,'IPv4-mapped addresses match IPv4 ranges');
 assert.equal(ipAllowed('::1',['::1']),true);assert.equal(ipAllowed('anything',[]),true,'an empty list allows everyone');
 assert.equal(ipAllowed(undefined,['10.0.0.0/8']),false);
});
test('quotas',()=>{
 const usage={servers:2,memoryMb:2048,cpuPercent:200,diskMb:4096,backups:1,extraPorts:0};
 assert.equal(quotaProblem({},usage,{servers:5}),null);
 assert.match(quotaProblem({maxServers:2},usage,{servers:1})!,/limit of 2 servers/);
 assert.equal(quotaProblem({maxServers:3},usage,{servers:1}),null);
 assert.match(quotaProblem({maxMemoryMb:2560},usage,{memoryMb:1024})!,/memory/);
 assert.equal(quotaProblem({maxExtraPorts:0},usage,{}),null,'no change, no problem');
 assert.match(quotaProblem({maxExtraPorts:0},usage,{extraPorts:1})!,/extra ports/);
 assert.deepEqual(validateQuota({maxServers:'3',maxDiskMb:''}),{maxServers:3});assert.deepEqual(validateQuota(null),{});
 assert.throws(()=>validateQuota({maxServers:-1}));assert.throws(()=>validateQuota({nope:1}));assert.throws(()=>validateQuota([]));
});
test('typed template variables',()=>{
 const defs=validateDefs([{key:'LEVEL',type:'select',options:[{value:'a'},{value:'b'}],userEditable:true},{key:'N',type:'number',min:1,max:5},{key:'P',type:'string',pattern:'^x+$',min:2},{key:'B',type:'boolean'}]);
 const d=(k:string)=>defs.find(x=>x.key===k)!;
 assert.equal(checkValue(d('LEVEL'),'a'),'a');assert.throws(()=>checkValue(d('LEVEL'),'c'));
 assert.equal(checkValue(d('N'),3),'3');assert.throws(()=>checkValue(d('N'),'0'));assert.throws(()=>checkValue(d('N'),'1e3'));assert.throws(()=>checkValue(d('N'),'x'));
 assert.equal(checkValue(d('P'),'xx'),'xx');assert.throws(()=>checkValue(d('P'),'x'));assert.throws(()=>checkValue(d('P'),'yy'));
 assert.equal(checkValue(d('B'),'true'),'true');assert.throws(()=>checkValue(d('B'),'maybe'));
 assert.equal(effectiveDefs({variables:defs,editable_variables:['LEVEL','OLD']}).filter(x=>x.key==='OLD')[0].type,'string','legacy editable variables become text fields');
});
test('cron and schedule steps',()=>{
 const t=new Date('2026-10-02T12:00:00Z');
 assert.deepEqual(cronNext('0 4 * * *','UTC',t,2).map(x=>x.toISOString()),['2026-10-03T04:00:00.000Z','2026-10-04T04:00:00.000Z']);
 assert.equal(cronNext('0 4 * * *','Europe/Berlin',t,1)[0].toISOString(),'2026-10-03T02:00:00.000Z','time zones apply (CEST)');
 assert.throws(()=>cronNext('* * * *','UTC',t));assert.throws(()=>cronNext('0 0 * * * *','UTC',t));
 assert.throws(()=>checkCron('* * * * *','UTC'));assert.throws(()=>checkCron('0 0 * * *','Nowhere/City'));assert.doesNotThrow(()=>checkCron('*/5 * * * *','UTC'));
 assert.equal(validateTasks([{action:'wait',seconds:5},{action:'power',power:'restart'}]).length,2);
 assert.throws(()=>validateTasks([]));assert.throws(()=>validateTasks([{action:'wait',seconds:5000}]));assert.throws(()=>validateTasks([{action:'command',command:'a\nb'}]));
 assert.deepEqual(tasksOf({kind:'backup',tasks:[]}),[{action:'backup'}]);assert.deepEqual(tasksOf({kind:'command',command:'save-all',tasks:[]}),[{action:'command',command:'save-all'}]);
});
test('add-on capability comes from the template rules and the server variables',()=>{
 const rules={versionVar:'VERSION',typeVar:'TYPE',types:{PAPER:{kind:'plugin',dir:'/plugins',loaders:['paper']},FABRIC:{kind:'mod',dir:'/mods',loaders:['fabric']}}};
 const cap=(env:any,variables:any={},template_addons:any=rules)=>capabilityFor({template_addons,env,variables});
 assert.deepEqual(cap({TYPE:'PAPER',VERSION:'1.21.11'}),{supported:true,kind:'plugin',dir:'/plugins',loaders:['paper'],gameVersion:'1.21.11',type:'PAPER'});
 assert.equal(cap({TYPE:'PAPER',VERSION:'1.21.11'},{TYPE:'fabric'}).kind,'mod','server variables override the template');
 assert.equal(cap({TYPE:'PAPER',VERSION:'LATEST'}).gameVersion,null,'LATEST is not a concrete version');
 assert.equal(cap({TYPE:'VANILLA'}).supported,false);assert.equal(cap({}).supported,false);assert.equal(cap({TYPE:'PAPER'},{},null).supported,false);
});
test('crash policy normalisation and validation',()=>{
 assert.equal(normalizePolicy(undefined).mode,'off');assert.equal(normalizePolicy({mode:'weird'}).mode,'off');
 assert.deepEqual(normalizePolicy({mode:'always',maxRestarts:99,backoffSeconds:[1,99999]}).backoffSeconds,[5,3600]);assert.equal(normalizePolicy({mode:'always',maxRestarts:99}).maxRestarts,20);
 assert.throws(()=>validatePolicy({mode:'on-failure',maxRestarts:0}));assert.throws(()=>validatePolicy({mode:'x'}));
 assert.equal(validatePolicy({mode:'on-failure'}).maxRestarts,3);
});
test('notification payloads work with Slack, Discord and Mattermost',()=>{
 const ev={kind:'server.crashed',severity:'bad' as const,title:'S crashed',body:'exit 1',server:{id:'1',name:'S'}};
 assert.deepEqual(Object.keys(payloadFor('discord',ev)),['content']);assert.deepEqual(Object.keys(payloadFor('slack',ev)),['text']);
 const g:any=payloadFor('webhook',ev);assert.ok(g.text&&g.content&&g.event.kind==='server.crashed');
 assert.ok((payloadFor('slack',{...ev,body:'x'.repeat(5000)}) as any).text.length<=1900);
 assert.ok(EVENTS.every(e=>/^[a-z]+\.[a-z_]+$/.test(e.id)));assert.equal(new Set(EVENTS.map(e=>e.id)).size,EVENTS.length);
});
test('private address detection for outbound requests',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.0.5','169.254.169.254','::1','fd00::1','::ffff:7f00:1'])assert.equal(isPrivateAddress(ip),true,ip);
 for(const ip of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(isPrivateAddress(ip),false,ip);
});
test('patterns from template and plugin authors cannot freeze the API',()=>{
 const t=Date.now();
 assert.equal(safeTest(['^(a+',')+$'].join(''),'a'.repeat(40)+'b'),false);
 assert.ok(Date.now()-t<1000,'a catastrophic pattern is cut off');
 assert.equal(safeTest('^[a-z]+$','abc'),true);assert.equal(safeTest('^[a-z]+$','ABC'),false);
 assert.equal(validPattern('('),false);assert.equal(validPattern('x'.repeat(201)),false);assert.equal(validPattern('^ok$'),true);
});
test('plugins cannot be granted wildcards over shared hosting platforms',()=>{
 for(const h of ['*.github.io','*.vercel.app','*.amazonaws.com','*.pages.dev'])assert.match(String(permissionProblem('network:'+h)),/shared hosting/,h);
 assert.equal(permissionProblem('network:api.modrinth.com'),null);assert.equal(permissionProblem('network:*.modrinth.com'),null);
});
test('the API reference only offers bearer tokens where tokens can actually go',()=>{
 assert.equal(tokenScopeFor('GET','/api/servers'),'read');assert.equal(tokenScopeFor('POST','/api/servers/:id/actions'),'suspend');
 assert.equal(tokenScopeFor('POST','/api/customers'),'provision');
 assert.equal(tokenScopeFor('GET','/api/nodes'),null);assert.equal(tokenScopeFor('GET','/api/activity'),null);
});
test('address checks accept normal addresses and reject odd ones without backtracking',()=>{
 for(const a of ['a@b.co','first.last+tag@mail.example.org'])assert.equal(looksLikeEmail(a),true,a);
 for(const a of ['','a@b','a@@b.co','@b.co','a@.co','a@b.','a b@c.de','a@b.c<d>',5 as any])assert.equal(looksLikeEmail(a),false,String(a));
 assert.equal(looksLikeMailbox('Fledge <admin@example.com>'),true);assert.equal(looksLikeMailbox('admin@example.com'),true);
 assert.equal(looksLikeMailbox('Fledge <admin@example>'),false);assert.equal(looksLikeMailbox('<a@b.co>'),false);assert.equal(looksLikeMailbox('x'.repeat(5000)+'@'),false);
});
