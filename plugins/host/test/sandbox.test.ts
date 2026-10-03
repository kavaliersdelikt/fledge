import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {runPlugin,PluginError,type RunInput} from '../src/sandbox.js';
import {isPrivateAddress,hostAllowed,guardedFetch,resetRateLimits} from '../src/netguard.js';

const base=(code:string,over:Partial<RunInput>={}):RunInput=>({code,method:'run',args:[],settings:{},storage:{},network:[],plugin:{id:'t',version:'1'},...over});

test('returns JSON from async plugin functions and passes arguments and settings', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={async run(a,b){return {sum:a+b,s:host.settings.greeting,ctx:host.context.pluginId};}};`,{args:[2,3],settings:{greeting:'hi'}}));
 assert.deepEqual(out.result,{sum:5,s:'hi',ctx:'t'});
});
test('plugin code has no Node, network or timer globals', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={run(){return {process:typeof process,require:typeof require,fetch:typeof fetch,setTimeout:typeof setTimeout,Buffer:typeof Buffer,XMLHttpRequest:typeof XMLHttpRequest,raw:typeof __call};}};`));
 assert.deepEqual(out.result,{process:'undefined',require:'undefined',fetch:'undefined',setTimeout:'undefined',Buffer:'undefined',XMLHttpRequest:'undefined',raw:'undefined'});
});
test('constructor-chain escapes find nothing outside the sandbox', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={run(){var F=(function(){}).constructor;var p;try{p=typeof F('return process')();}catch(e){p='blocked';}var g=F('return this')();return {p:p,fs:typeof g.require,proc:typeof g.process};}};`));
 assert.equal((out.result as any).p==='blocked'||(out.result as any).p==='undefined',true);
 assert.equal((out.result as any).fs,'undefined');
 assert.equal((out.result as any).proc,'undefined');
});
test('host object cannot be replaced or extended by the plugin', async()=>{
 const out=await runPlugin(base(`'use strict';globalThis.fledgePlugin={run(){var r={};try{globalThis.host=1;r.replaced=true;}catch(e){r.replaced=false;}try{host.fetch=null;r.mutated=true;}catch(e){r.mutated=false;}return r;}};`));
 assert.deepEqual(out.result,{replaced:false,mutated:false});
});
test('runaway loops are interrupted', async()=>{
 await assert.rejects(runPlugin(base(`globalThis.fledgePlugin={run(){for(;;){}}};`,{limits:{deadlineMs:400}})),(e:any)=>e instanceof PluginError&&e.code==='timeout');
});
test('memory bombs are stopped', async()=>{
 await assert.rejects(runPlugin(base(`globalThis.fledgePlugin={run(){var a=[];for(;;)a.push(new Array(100000).fill('x'.repeat(100)));}};`,{limits:{memoryBytes:8<<20,deadlineMs:5000}})),(e:any)=>e instanceof PluginError);
});
test('syntax errors and missing methods are reported clearly', async()=>{
 await assert.rejects(runPlugin(base('this is not javascript')),(e:any)=>e.code==='script-error');
 await assert.rejects(runPlugin(base('globalThis.fledgePlugin={};')),/does not implement run/);
});
test('thrown errors surface their message and logs are collected', async()=>{
 await assert.rejects(runPlugin(base(`globalThis.fledgePlugin={run(){console.log('before',{a:1});throw new Error('nope');}};`)),(e:any)=>e.message.includes('nope')&&e.logs.some((l:any)=>l.message==='before {"a":1}'));
});
test('result size is limited', async()=>{
 await assert.rejects(runPlugin(base(`globalThis.fledgePlugin={run(){return 'x'.repeat(5000);}};`,{limits:{maxResultBytes:1000}})),(e:any)=>e.code==='too-large');
});
test('storage changes are returned and respect the quota', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={run(){host.storage.set('a',{n:1});host.storage.delete('b');return [host.storage.get('b')===undefined,host.storage.get('a')];}};`,{storage:{b:2}}));
 assert.deepEqual(out.result,[true,{n:1}]);
 assert.deepEqual(out.storageSet,{a:{n:1}});assert.deepEqual(out.storageDelete,['b']);
 await assert.rejects(runPlugin(base(`globalThis.fledgePlugin={run(){host.storage.set('big','x'.repeat(5000));}};`,{limits:{maxStorageBytes:1000}})),/storage is full/);
});
test('fetch is refused for hosts the plugin did not declare', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={async run(){try{await host.fetch('https://example.com/');return 'allowed';}catch(e){return e.message;}}};`,{network:['api.modrinth.com']}));
 assert.match(String(out.result),/may not contact example\.com/);
});
test('fetch refuses private and local addresses even when the host is declared', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={async run(){var r=[];for(var u of ['https://127.0.0.1/','https://localhost/','https://10.1.2.3/','https://[::1]/','https://169.254.169.254/latest/meta-data/']){try{await host.fetch(u);r.push('allowed');}catch(e){r.push(e.message);}}return r;}};`,{network:['127.0.0.1','localhost','10.1.2.3','::1','169.254.169.254']}));
 for(const m of out.result as string[])assert.match(m,/private|local|resolve|not allowed|may not contact/i);
 assert.equal((out.result as string[]).includes('allowed'),false);
});
test('fetch refuses plain HTTP and non-default ports', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={async run(){var r=[];for(var u of ['http://api.modrinth.com/v2/','https://api.modrinth.com:8443/']){try{await host.fetch(u);r.push('allowed');}catch(e){r.push(e.message);}}return r;}};`,{network:['api.modrinth.com']}));
 assert.deepEqual((out.result as string[]).map(m=>/Only HTTPS|default HTTPS port/.test(m)),[true,true]);
});

// Local server on 127.0.0.1 with the unsafe test flags so real fetching can be exercised.
async function withServer(handler:(req:any,res:any)=>void,fn:(port:number)=>Promise<void>){
 const s=createServer(handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));
 try{await fn((s.address() as AddressInfo).port);}finally{await new Promise(r=>s.close(r));}
}
const local={allowPrivate:true,allowHttp:true};
test('fetch returns status, headers and body to the plugin', async()=>{
 resetRateLimits();
 await withServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({path:req.url,ua:req.headers['user-agent']}));},async port=>{
  const out=await runPlugin(base(`globalThis.fledgePlugin={async run(){var r=await host.fetch('http://127.0.0.1:${port}/v2/x?q=1',{headers:{'user-agent':'Fledge-test'}});return {s:r.status,ok:r.ok,j:r.json(),ct:r.headers['content-type']};}};`,{network:['127.0.0.1'],guard:local}));
  assert.deepEqual(out.result,{s:200,ok:true,j:{path:'/v2/x?q=1',ua:'Fledge-test'},ct:'application/json'});
  assert.equal(out.stats.fetches,1);
 });
});
test('redirects to hosts the plugin did not declare are refused', async()=>{
 resetRateLimits();
 await withServer((req,res)=>{res.writeHead(302,{location:'http://localhost:1/secret'});res.end();},async port=>{
  const out=await runPlugin(base(`globalThis.fledgePlugin={async run(){try{await host.fetch('http://127.0.0.1:${port}/');return 'followed';}catch(e){return e.message;}}};`,{network:['127.0.0.1'],guard:local}));
  assert.match(String(out.result),/may not contact localhost/);
 });
});
test('response size and request count are capped', async()=>{
 resetRateLimits();
 await withServer((req,res)=>{res.end('y'.repeat(50_000));},async port=>{
  const big=await runPlugin(base(`globalThis.fledgePlugin={async run(){try{await host.fetch('http://127.0.0.1:${port}/');return 'ok';}catch(e){return e.message;}}};`,{network:['127.0.0.1'],guard:local,limits:{maxFetchBytes:1000}}));
  assert.match(String(big.result),/larger than/);
  const many=await runPlugin(base(`globalThis.fledgePlugin={async run(){var n=0;for(var i=0;i<10;i++){try{await host.fetch('http://127.0.0.1:${port}/');n++;}catch(e){return [n,e.message];}}return [n];}};`,{network:['127.0.0.1'],guard:local,limits:{maxFetches:3}}));
  assert.deepEqual((many.result as any[])[0],3);assert.match(String((many.result as any[])[1]),/more than 3 requests/);
 });
});
test('parallel fetches from one plugin call all resolve', async()=>{
 resetRateLimits();
 await withServer((req,res)=>{setTimeout(()=>res.end(req.url),20);},async port=>{
  const out=await runPlugin(base(`globalThis.fledgePlugin={async run(){var rs=await Promise.all([1,2,3,4].map(function(i){return host.fetch('http://127.0.0.1:${port}/'+i).then(function(r){return r.text();});}));return rs;}};`,{network:['127.0.0.1'],guard:local}));
  assert.deepEqual(out.result,['/1','/2','/3','/4']);
 });
});
test('hooks are invoked through hook: names', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={hooks:{'server.created':function(e){return {got:e.id};}}};`,{method:'hook:server.created',args:[{id:'s1'}]}));
 assert.deepEqual(out.result,{got:'s1'});
});
test('private address classification', () => {
 for(const ip of ['127.0.0.1','10.0.0.5','172.16.9.9','172.31.255.255','192.168.1.1','169.254.1.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','fe80::1','fd00::1','::ffff:127.0.0.1','::ffff:7f00:1'])assert.equal(isPrivateAddress(ip),true,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','172.15.0.1','172.32.0.1','2606:4700:4700::1111'])assert.equal(isPrivateAddress(ip),false,ip);
});
test('host allow-list supports exact names and wildcards', () => {
 assert.equal(hostAllowed('api.modrinth.com',['api.modrinth.com']),true);
 assert.equal(hostAllowed('evil.com',['api.modrinth.com']),false);
 assert.equal(hostAllowed('cdn.modrinth.com',['*.modrinth.com']),true);
 assert.equal(hostAllowed('modrinth.com',['*.modrinth.com']),false);
 assert.equal(hostAllowed('xmodrinth.com',['*.modrinth.com']),false);
});
test('guardedFetch rejects credentials in URLs and unsupported methods', async()=>{
 await assert.rejects(guardedFetch('https://user:pw@api.modrinth.com/',{}, {hosts:['api.modrinth.com'],maxBytes:100,timeoutMs:1000}),/credentials/);
 await assert.rejects(guardedFetch('https://api.modrinth.com/',{method:'DELETE'}, {hosts:['api.modrinth.com'],maxBytes:100,timeoutMs:1000}),/Only GET/);
});

test('a timeout while a request is still pending is reported as the upstream being slow', async()=>{
 resetRateLimits();
 await withServer((_req,_res)=>{/* never answers */},async port=>{
  await assert.rejects(runPlugin(base(`globalThis.fledgePlugin={async run(){await host.fetch('http://127.0.0.1:${port}/');}};`,{network:['127.0.0.1'],guard:local,limits:{deadlineMs:500}})),(e:any)=>e instanceof PluginError&&e.code==='upstream-timeout');
 });
});
test('storage without the permission throws instead of being dropped silently', async()=>{
 await assert.rejects(runPlugin(base(`globalThis.fledgePlugin={run(){host.storage.set('a',1);}};`,{storageAllowed:false})),/no "storage" permission/);
 const ok=await runPlugin(base(`globalThis.fledgePlugin={run(){host.storage.set('a',1);return 1;}};`,{storageAllowed:true}));
 assert.deepEqual(ok.storageSet,{a:1});
});
test('overwriting a storage key does not count its old size again', async()=>{
 const out=await runPlugin(base(`globalThis.fledgePlugin={run(){for(var i=0;i<20;i++)host.storage.set('k','x'.repeat(100));return 1;}};`,{limits:{maxStorageBytes:400}}));
 assert.deepEqual(out.storageSet,{k:'x'.repeat(100)});
});
