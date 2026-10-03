import {getQuickJS,shouldInterruptAfterDeadline,type QuickJSContext,type QuickJSHandle} from 'quickjs-emscripten';
import {guardedFetch,GuardError,type GuardOptions} from './netguard.js';

// Plugin code runs inside QuickJS compiled to WebAssembly: its own heap, no Node APIs, no
// file system, no network, no timers. The only way out is the `host` object below, and
// every call on it is checked here against what the admin approved.

export type Limits={memoryBytes:number;stackBytes:number;deadlineMs:number;maxFetches:number;maxFetchBytes:number;maxTotalBytes:number;maxResultBytes:number;maxLogLines:number;maxStorageBytes:number};
export const defaultLimits:Limits={memoryBytes:64<<20,stackBytes:1<<20,deadlineMs:25_000,maxFetches:40,maxFetchBytes:8<<20,maxTotalBytes:24<<20,maxResultBytes:2<<20,maxLogLines:100,maxStorageBytes:256<<10};

export type RunInput={
 code:string;method:string;args:unknown[];
 settings:Record<string,unknown>;storage:Record<string,unknown>;storageAllowed?:boolean;network:string[];
 plugin:{id:string;version:string;panelVersion?:string};
 limits?:Partial<Limits>;guard?:GuardOptions;
};
export type RunOutput={result:unknown;logs:{level:string;message:string}[];storageSet:Record<string,unknown>;storageDelete:string[];stats:{fetches:number;bytes:number;ms:number}};
export class PluginError extends Error{constructor(message:string,public code='plugin-error',public logs:{level:string;message:string}[]=[]){super(message);this.name='PluginError';}}

const prelude=`(function(){
 var call=globalThis.__call;delete globalThis.__call;
 var init=JSON.parse(call('init',''));
 var local=init.storage;
 var fmt=function(a){return Array.prototype.map.call(a,function(x){if(typeof x==='string')return x;try{return JSON.stringify(x);}catch(e){return String(x);}}).join(' ');};
 var log=function(level){return function(){call('log',JSON.stringify([level,fmt(arguments)]));};};
 var host={
  settings:init.settings,context:init.context,
  log:function(level){call('log',JSON.stringify([String(level),fmt(Array.prototype.slice.call(arguments,1))]));},
  storage:{
   get:function(k){return Object.prototype.hasOwnProperty.call(local,k)?local[k]:undefined;},
   set:function(k,v){local[k]=v;call('storageSet',JSON.stringify([String(k),v===undefined?null:v]));},
   delete:function(k){delete local[k];call('storageDelete',JSON.stringify([String(k)]));}
  },
  fetch:function(url,opts){
   return call('fetch',JSON.stringify([String(url),opts||{}])).then(function(raw){
    var o=JSON.parse(raw);
    if(o.error){var e=new Error(o.error);e.code=o.code;throw e;}
    return {status:o.status,ok:o.status>=200&&o.status<300,headers:o.headers,text:function(){return o.body;},json:function(){return JSON.parse(o.body);}};
   });
  }
 };
 Object.freeze(host.storage);Object.freeze(host);
 Object.defineProperty(globalThis,'host',{value:host,writable:false,configurable:false,enumerable:true});
 globalThis.console={log:log('info'),info:log('info'),warn:log('warn'),error:log('error'),debug:log('debug')};
})();`;

const methodOk=/^(?:[A-Za-z][A-Za-z0-9]{0,40}|hook:[a-z][a-zA-Z.]{0,60})$/;

export async function runPlugin(input:RunInput):Promise<RunOutput>{
 if(!methodOk.test(input.method))throw new PluginError('Invalid method name','bad-method');
 const limits={...defaultLimits,...input.limits};
 const started=Date.now();
 const QuickJS=await getQuickJS();
 const runtime=QuickJS.newRuntime();
 runtime.setMemoryLimit(limits.memoryBytes);
 runtime.setMaxStackSize(limits.stackBytes);
 const deadline=started+limits.deadlineMs;
 runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
 const vm=runtime.newContext();
 let disposed=false;
 const logs:{level:string;message:string}[]=[];
 const storageSet:Record<string,unknown>={};const storageDelete=new Set<string>();
 let fetches=0,totalBytes=0,inflight=0;
 const storageSizes=new Map<string,number>(Object.entries(input.storage).map(([k,v])=>[k,Buffer.byteLength(JSON.stringify(v))]));
 const storageTotal=()=>{let n=0;for(const v of storageSizes.values())n+=v;return n;};
 // A timeout while a request to the catalog was still pending is the upstream's slowness, not a broken plugin.
 const timeoutCode=()=>inflight>0?'upstream-timeout':'timeout';
 const pump=()=>{if(!disposed){try{runtime.executePendingJobs();}catch{/* surfaced through the awaited promise */}}};
 const pushLog=(level:string,message:string)=>{if(logs.length<limits.maxLogLines)logs.push({level:['debug','info','warn','error'].includes(level)?level:'info',message:String(message).slice(0,2000)});else if(logs.length===limits.maxLogLines)logs.push({level:'warn',message:'Log limit reached; further lines are dropped'});};
 const str=(h:QuickJSHandle)=>vm.getString(h);

 const call=vm.newFunction('__call',(opHandle,argHandle)=>{
  const op=str(opHandle),raw=str(argHandle);
  const plainString=(s:string)=>vm.newString(s);
  switch(op){
   case 'init':return plainString(JSON.stringify({settings:input.settings,storage:input.storage,context:{pluginId:input.plugin.id,version:input.plugin.version,panelVersion:input.plugin.panelVersion||''}}));
   case 'log':{try{const [level,message]=JSON.parse(raw);pushLog(String(level),String(message));}catch{/* ignore malformed log */}return vm.undefined;}
   case 'storageSet':{
    if(input.storageAllowed===false)throw new Error('This plugin has no "storage" permission, so host.storage cannot be used');
    const [k,v]=JSON.parse(raw);
    if(typeof k!=='string'||k.length>128)throw new Error('Storage keys are text up to 128 characters');
    const previousSize=storageSizes.get(k);storageSizes.set(k,Buffer.byteLength(JSON.stringify(v)));
    if(storageTotal()>limits.maxStorageBytes){if(previousSize===undefined)storageSizes.delete(k);else storageSizes.set(k,previousSize);throw new Error('Plugin storage is full');}
    storageSet[k]=v;storageDelete.delete(k);return vm.undefined;
   }
   case 'storageDelete':{
    if(input.storageAllowed===false)throw new Error('This plugin has no "storage" permission, so host.storage cannot be used');
    const [k]=JSON.parse(raw);delete storageSet[String(k)];storageDelete.add(String(k));storageSizes.delete(String(k));return vm.undefined;}
   case 'fetch':{
    const deferred=vm.newPromise();
    const [url,init]=JSON.parse(raw);
    const settle=(value:unknown)=>{if(disposed)return;const h=vm.newString(JSON.stringify(value));deferred.resolve(h);h.dispose();deferred.settled.then(pump);};
    (async()=>{
     inflight++;
     try{
     if(++fetches>limits.maxFetches)return {error:`This call made more than ${limits.maxFetches} requests`,code:'limit'};
     if(totalBytes>=limits.maxTotalBytes)return {error:'Response data limit reached',code:'limit'};
     const remaining=Math.max(1,Math.min(limits.maxFetchBytes,limits.maxTotalBytes-totalBytes));
     const wait=Math.max(1000,Math.min(15_000,deadline-Date.now()-500));
     try{
      const r=await guardedFetch(url,{method:init?.method,headers:init?.headers&&typeof init.headers==='object'?init.headers:undefined,body:typeof init?.body==='string'?init.body:undefined},{hosts:input.network,maxBytes:remaining,timeoutMs:wait},input.guard);
      totalBytes+=r.bytes;return r;
     }catch(e:any){return {error:e instanceof GuardError?e.message:`Request failed: ${e?.message||'unknown error'}`,code:e instanceof GuardError?e.code:'network'};}
     }finally{inflight--;}
    })().then(settle,e=>settle({error:String(e?.message||e),code:'network'}));
    return deferred.handle;
   }
   default:throw new Error(`Unknown host operation ${op}`);
  }
 });
 vm.setProp(vm.global,'__call',call);call.dispose();

 const cleanup=()=>{if(disposed)return;disposed=true;try{vm.dispose();}catch{/* handles already freed */}try{runtime.dispose();}catch{/* idem */}};
 const fail=(e:unknown,code='plugin-error'):never=>{
  const msg=typeof e==='object'&&e&&'message' in (e as any)?String((e as any).message):String(e);
  const interrupted=Date.now()>=deadline;
  throw new PluginError(interrupted?`The plugin ran longer than ${Math.round(limits.deadlineMs/1000)} seconds`:msg.slice(0,600),interrupted?timeoutCode():code,logs);
 };
 const dump=(h:QuickJSHandle)=>{const v=vm.dump(h);h.dispose();return v;};
 const evalChecked=(code:string,name:string)=>{const r=vm.evalCode(code,name);if(r.error){const err=vm.dump(r.error);r.error.dispose();const message=typeof err==='object'&&err?`${err.name||'Error'}: ${err.message||''}`:String(err);return fail(new Error(message),'script-error');}return r.value;};
 try{
  evalChecked(prelude,'prelude.js').dispose();
  evalChecked(input.code,'plugin.js').dispose();
  // The method name and arguments are handed over as data; the code that runs them is a constant.
  const setGlobal=(name:string,value:string)=>{const h=vm.newString(value);vm.setProp(vm.global,name,h);h.dispose();};
  setGlobal('__method',input.method);setGlobal('__args',JSON.stringify(input.args));
  const promise=evalChecked(`(async function(){var name=globalThis.__method,args=globalThis.__args,fp=globalThis.fledgePlugin;var fn=fp&&(name.indexOf('hook:')===0?(fp.hooks&&fp.hooks[name.slice(5)]):fp[name]);if(typeof fn!=='function')throw new Error('The plugin does not implement '+name.replace(/[^A-Za-z0-9_.:-]/g,''));var out=await fn.apply(fp,JSON.parse(args));return out===undefined?'null':JSON.stringify(out);})()`,'call.js');
  const settled=vm.resolvePromise(promise);promise.dispose();
  pump();
  const timer=new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new PluginError(`The plugin ran longer than ${Math.round(limits.deadlineMs/1000)} seconds`,timeoutCode(),logs)),Math.max(100,deadline-Date.now()+200));t.unref?.();});
  const outcome=await Promise.race([settled,timer]);
  if(outcome.error){const err=vm.dump(outcome.error);outcome.error.dispose();return fail(new Error(typeof err==='object'&&err?`${err.message||err.name||'Error'}`:String(err)));}
  const text=dump(outcome.value);
  if(typeof text!=='string')return fail(new Error('The plugin returned something that is not JSON'));
  if(Buffer.byteLength(text)>limits.maxResultBytes)return fail(new Error('The plugin returned too much data'),'too-large');
  let result:unknown;try{result=JSON.parse(text);}catch{return fail(new Error('The plugin returned invalid JSON'));}
  return {result,logs,storageSet,storageDelete:[...storageDelete],stats:{fetches,bytes:totalBytes,ms:Date.now()-started}};
 }catch(e){
  if(e instanceof PluginError)throw e;
  return fail(e);
 }finally{cleanup();}
}
