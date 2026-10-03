import test from 'node:test';
import assert from 'node:assert/strict';
import {combine,problemOf,type Usage} from '../src/limits.ts';
import {validateLimitSet,toStorage,fromStorage,validateRookery,defaultSignup,defaultLimits,defaultBilling,defaultStore,defaultSelfService} from '../src/rookery-settings.ts';
import {fill,mentioned,lintTemplate} from '../src/email.ts';
import {TEMPLATES,COMMON_VARS} from '../src/email-defaults.ts';
import {exponent,formatMoney,parseMajor,savingsPercent,addMonths,perMonth} from '../src/money.ts';

const usage:Usage={servers:2,runningServers:1,memoryMb:4096,cpuPercent:200,diskMb:20000,backups:3,backupStorageMb:500,extraPorts:1};

test('limits: layers combine and sources are explained',()=>{
 // no defaults and no plans: nothing limited
 let r=combine({},[],null);
 assert.equal(r.values.servers,undefined);assert.equal(r.sources.servers.source,'none');
 // defaults only
 r=combine({servers:2,maxServerMemoryMb:2048},[],null);
 assert.equal(r.values.servers,2);assert.equal(r.sources.servers.source,'default');
 // plans add up on top of defaults
 r=combine({servers:1,memoryMb:2048},[{name:'A',limits:{servers:2,memoryMb:4096}},{name:'B',limits:{servers:3}}],null);
 assert.equal(r.values.servers,6);assert.equal(r.values.memoryMb,6144);assert.deepEqual(r.sources.servers.plans,['A','B']);assert.equal(r.sources.servers.source,'plan');
 // a plan limit applies even when there is no default (the plan is the cap)
 r=combine({},[{name:'A',limits:{servers:5}}],null);
 assert.equal(r.values.servers,5);
 // unlimited wins over numbers, either in a plan or as the default
 r=combine({servers:1},[{name:'A',limits:{servers:null}}],null);assert.equal(r.values.servers,null);
 r=combine({servers:null},[{name:'A',limits:{servers:3}}],null);assert.equal(r.values.servers,null);
 // maxima: the most generous layer wins
 r=combine({maxServerMemoryMb:2048},[{name:'A',limits:{maxServerMemoryMb:8192}}],null);assert.equal(r.values.maxServerMemoryMb,8192);assert.equal(r.sources.maxServerMemoryMb.source,'plan');
 r=combine({maxServerMemoryMb:8192},[{name:'A',limits:{maxServerMemoryMb:2048}}],null);assert.equal(r.values.maxServerMemoryMb,8192);assert.equal(r.sources.maxServerMemoryMb.source,'default');
 // lists: union; undefined default stays unrestricted unless a plan defines the list
 r=combine({allowedTemplates:['a']},[{name:'A',limits:{allowedTemplates:['b']}}],null);assert.deepEqual(r.values.allowedTemplates,['a','b']);
 r=combine({},[],null);assert.equal(r.values.allowedTemplates,undefined);
 // flags: any layer that allows it allows it
 r=combine({sftp:false},[{name:'A',limits:{sftp:true}}],null);assert.equal(r.values.sftp,true);
 r=combine({sftp:false},[],null);assert.equal(r.values.sftp,false);
 // an override always wins, including "unlimited"
 r=combine({servers:1},[{name:'A',limits:{servers:2}}],{servers:null,memoryMb:10});
 assert.equal(r.values.servers,null);assert.equal(r.sources.servers.source,'override');assert.equal(r.values.memoryMb,10);
});

test('limits: what a change would break',()=>{
 const r=combine({servers:2,memoryMb:5000,maxServerMemoryMb:2048,backupsPerServer:2,allowedTemplates:['mc'],allowedLocations:['eu']},[],null);
 assert.equal(problemOf(r,usage,{}),null,'no change, no problem');
 assert.match(problemOf(r,usage,{servers:1})!.message,/limit of 2 servers/);
 assert.equal(problemOf(r,{...usage,servers:1},{servers:1}),null);
 assert.equal(problemOf(r,usage,{memoryMb:1000})!.limit,'memoryMb');
 assert.equal(problemOf(r,usage,{memoryMb:100,server:{memoryMb:4096,cpuPercent:1,diskMb:1}})!.limit,'maxServerMemoryMb');
 assert.equal(problemOf(r,usage,{backupsOnServer:2})!.limit,'backupsPerServer');
 assert.equal(problemOf(r,usage,{backupsOnServer:1}),null);
 assert.equal(problemOf(r,usage,{templateId:'valheim'})!.limit,'allowedTemplates');
 assert.equal(problemOf(r,usage,{templateId:'mc',location:'us'})!.limit,'allowedLocations');
 assert.equal(problemOf(r,usage,{templateId:'mc',location:'eu'}),null);
 // zero means none at all
 const none=combine({servers:0},[],null);
 assert.match(problemOf(none,{...usage,servers:0},{servers:1})!.message,/limit of 0 servers/);
});

test('limits: names from 0.6.x keep working and are stored as before',()=>{
 const set=validateLimitSet({maxServers:'3',maxDiskMb:'',maxBackups:0,runningServers:2,sftp:false,allowedLocations:['eu','eu']});
 assert.deepEqual(set,{servers:3,backups:0,runningServers:2,sftp:false,allowedLocations:['eu']});
 assert.deepEqual(toStorage(set),{maxServers:3,maxBackups:0,runningServers:2,sftp:false,allowedLocations:['eu']});
 assert.deepEqual(fromStorage({maxServers:3}),{servers:3});
 assert.deepEqual(validateLimitSet(null),{});
 assert.throws(()=>validateLimitSet({servers:-1}));assert.throws(()=>validateLimitSet({nope:1}));assert.throws(()=>validateLimitSet([]));
 assert.throws(()=>validateLimitSet({sftp:'yes'}));assert.throws(()=>validateLimitSet({allowedTemplates:'a'}));
 assert.equal(validateLimitSet({servers:null}).servers,null);
});

test('settings: defaults are valid and safe',()=>{
 const cur={signup:defaultSignup()} as any;
 assert.equal(defaultSignup().mode,'off');assert.equal(defaultSelfService().mode,'off');assert.equal(defaultStore().enabled,false);
 assert.equal(defaultLimits().enabled,true,'limits keep enforcing after an upgrade');assert.equal(defaultBilling().autoTerminate,false,'nothing is deleted automatically');
 // each default round-trips through its own validator
 assert.deepEqual(validateRookery('signup',defaultSignup(),cur),defaultSignup());
 assert.deepEqual(validateRookery('selfService',defaultSelfService(),{}),defaultSelfService());
 assert.deepEqual(validateRookery('limits',defaultLimits(),{}),defaultLimits());
 assert.deepEqual(validateRookery('billing',defaultBilling(),{}),defaultBilling());
 assert.deepEqual(validateRookery('store',defaultStore(),{}),defaultStore());
 assert.throws(()=>validateRookery('signup',{...defaultSignup(),mode:'wild'},cur));
 assert.throws(()=>validateRookery('signup',{...defaultSignup(),captchaProvider:'turnstile'},cur),'a captcha needs keys');
 assert.throws(()=>validateRookery('signup',{...defaultSignup(),requireTerms:true},cur),'terms need an address');
 assert.throws(()=>validateRookery('billing',{...defaultBilling(),terminateAfterDays:3,suspendAfterDays:7},{}),'termination must follow suspension');
 assert.throws(()=>validateRookery('billing',{...defaultBilling(),currency:'euro'},{}));
 assert.throws(()=>validateRookery('store',{...defaultStore(),termsUrl:'javascript:alert(1)'},{}));
 assert.equal(validateRookery('store',{...defaultStore(),companyEmail:'billing@example.com'},{}).companyEmail,'billing@example.com');
 assert.throws(()=>validateRookery('store',{...defaultStore(),companyEmail:'!@!.'.repeat(50)},{}));
 assert.equal(validateRookery('signup',{...defaultSignup(),blockedDomains:['@Spam.Example']},cur).blockedDomains[0],'spam.example');
});

test('email: templates fill, escape and refuse unknown variables',()=>{
 assert.equal(fill('Hi {{name}}!',{name:'<b>Al</b>'},s=>s.replace(/</g,'&lt;')),'Hi &lt;b>Al&lt;/b>!');
 assert.equal(fill('A{{#if x}} B {{x}}{{/if}}C',{x:'1'}),'A B 1C');assert.equal(fill('A{{#if x}} B{{/if}}C',{x:''}),'AC');assert.equal(fill('{{missing}}!',{}),'!');
 assert.deepEqual(mentioned('{{a}} {{#if b}}{{c}}{{/if}}').sort(),['a','b','c']);
 const verify=TEMPLATES.find(t=>t.id==='verify_email')!;
 assert.deepEqual(lintTemplate(verify,verify.subject,verify.body),[]);
 assert.ok(lintTemplate(verify,verify.subject,'{{nope}}').some(p=>/Unknown variable/.test(p)));
 assert.ok(lintTemplate(verify,verify.subject,'No link here').some(p=>/\{\{link\}\}/.test(p)),'a critical email must keep its link');
 assert.ok(lintTemplate(verify,'',verify.body).length>0);assert.ok(lintTemplate(verify,verify.subject,'{{#if link}}x').some(p=>/matching/.test(p)));
 // every built-in template lints clean and only mentions variables it declares
 for(const t of TEMPLATES){assert.deepEqual(lintTemplate(t,t.subject,t.body),[],t.id);}
 assert.equal(new Set(TEMPLATES.map(t=>t.id)).size,TEMPLATES.length,'ids are unique');
 assert.ok(COMMON_VARS.length>=7);
});

test('money: integers, formats and intervals',()=>{
 assert.equal(exponent('eur'),2);assert.equal(exponent('jpy'),0);assert.equal(exponent('bhd'),3);
 assert.equal(formatMoney(850,'eur'),'€8.50');assert.equal(formatMoney('1200','usd'),'$12.00');assert.equal(formatMoney(500,'jpy'),'¥500');
 assert.equal(parseMajor('8','eur'),800);assert.equal(parseMajor('8,5','eur'),850);assert.equal(parseMajor('0.07','eur'),7);assert.equal(parseMajor('500','jpy'),500);
 assert.equal(parseMajor('19.99','eur'),1999,'no floating point drift');
 assert.throws(()=>parseMajor('8.505','eur'));assert.throws(()=>parseMajor('abc','eur'));assert.throws(()=>parseMajor('-1','eur'));assert.throws(()=>parseMajor('1.5','jpy'));
 assert.equal(perMonth(1200,'year'),100);assert.equal(savingsPercent(1000,10000,'year'),17);assert.equal(savingsPercent(1000,12000,'year'),0);assert.equal(savingsPercent(null,10,'year'),0);
 assert.equal(addMonths(new Date('2026-01-31T00:00:00Z'),1).toISOString().slice(0,10),'2026-02-28');
 assert.equal(addMonths(new Date('2026-11-30T00:00:00Z'),3).toISOString().slice(0,10),'2027-02-28');
 assert.equal(addMonths(new Date('2026-03-15T00:00:00Z'),12).toISOString().slice(0,10),'2027-03-15');
});

import {canMove,mapProviderStatus,dunningActions,isLive,type Status} from '../src/billing/states.ts';
test('subscriptions: only legal moves, and the provider cannot undo a suspension',()=>{
 const all:Status[]=['incomplete','trialing','active','past_due','suspended','canceled','terminated'];
 assert.equal(canMove('incomplete','active'),true);assert.equal(canMove('active','incomplete'),false);assert.equal(canMove('terminated','active'),false);assert.equal(canMove('canceled','active'),true,'a cancelled manual grant can be restored');
 assert.equal(canMove('past_due','trialing'),false);assert.equal(canMove('suspended','past_due'),false);assert.equal(canMove('suspended','terminated'),true);
 for(const s of all)assert.equal(canMove(s,s),true,'staying put is always fine');
 assert.equal(mapProviderStatus('active','past_due'),'past_due');assert.equal(mapProviderStatus('suspended','past_due'),'suspended');assert.equal(mapProviderStatus('suspended','unpaid'),'suspended');
 assert.equal(mapProviderStatus('suspended','active'),'active','a payment lifts it');assert.equal(mapProviderStatus('suspended','trialing'),'trialing');
 assert.equal(mapProviderStatus('incomplete','incomplete_expired'),'canceled');assert.equal(mapProviderStatus('active','incomplete_expired'),'active');
 assert.equal(mapProviderStatus('active','canceled'),'canceled');assert.equal(mapProviderStatus('terminated','canceled'),'terminated');assert.equal(mapProviderStatus('canceled','past_due'),'canceled');
 assert.equal(mapProviderStatus('active','paused'),'suspended');
 assert.equal(isLive('past_due'),true);assert.equal(isLive('suspended'),false);
});

test('dunning: reminders, suspension and termination happen once, on time',()=>{
 const cfg={reminderDays:[0,3,14],suspendAfterDays:7,terminateAfterDays:30,autoTerminate:false};
 const since=new Date('2026-01-01T00:00:00Z'),at=(d:number)=>new Date(since.getTime()+d*86400000+3600000);
 assert.deepEqual(dunningActions('active',since,at(5),cfg),[],'only unpaid subscriptions are chased');
 assert.deepEqual(dunningActions('past_due',null,at(5),cfg),[]);
 assert.deepEqual(dunningActions('past_due',since,at(1),cfg),[],'day 0 is sent when it fails, not here');
 assert.deepEqual(dunningActions('past_due',since,at(3),cfg),[{kind:'reminder',day:3}]);
 assert.deepEqual(dunningActions('past_due',since,at(3),cfg,{sent:{r3:'x'}}),[],'never twice');
 assert.deepEqual(dunningActions('past_due',since,at(8),cfg,{sent:{r3:'x'}}),[{kind:'suspend',day:7}]);
 assert.deepEqual(dunningActions('suspended',since,at(15),cfg,{sent:{r3:'x',suspend:'x'}}),[{kind:'final',day:14}],'after suspension the warnings are final warnings');
 assert.deepEqual(dunningActions('suspended',since,at(40),cfg,{sent:{r3:'x',r14:'x',suspend:'x'}}),[],'nothing is deleted unless the administrator asked for it');
 assert.deepEqual(dunningActions('suspended',since,at(40),{...cfg,autoTerminate:true},{sent:{r3:'x',r14:'x',suspend:'x'}}),[{kind:'terminate',day:30}]);
 // a server that was missed for a long time catches up in order
 assert.deepEqual(dunningActions('past_due',since,at(20),cfg).map(a=>a.kind),['reminder','final','suspend']);
});
