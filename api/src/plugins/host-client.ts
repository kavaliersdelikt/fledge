import {randomBytes} from 'node:crypto';
import {mkdir,open,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';

// Talks to the plugin host service (plugins/host). The host is a separate container with no
// database access; it only answers requests that carry the shared token.

const hostUrl=()=>(process.env.PLUGIN_HOST_URL||'').replace(/\/$/,'');
const tokenFile=()=>process.env.PLUGIN_TOKEN_FILE||'/run/fledge-plugins/token';
export type HostResult={ok:true;result:unknown;logs:{level:string;message:string}[];storageSet:Record<string,unknown>;storageDelete:string[];stats:{fetches:number;bytes:number;ms:number}}|{ok:false;error:string;code:string;logs:{level:string;message:string}[]};
export type Invocation={plugin:{id:string;version:string};sha:string;code:string;method:string;args:unknown[];settings:Record<string,unknown>;storage:Record<string,unknown>;storageAllowed?:boolean;network:string[];limits?:Record<string,number>};
export class HostUnavailable extends Error{constructor(message:string){super(message);this.name='HostUnavailable';}}

let cachedToken:string|undefined;
export async function hostToken(){
 if(cachedToken)return cachedToken;
 const file=tokenFile();
 await mkdir(dirname(file),{recursive:true});
 try{cachedToken=(await readFile(file,'utf8')).trim();if(cachedToken)return cachedToken;}catch(e:any){if(e?.code!=='ENOENT')throw e;}
 const token=randomBytes(32).toString('hex');
 try{const f=await open(file,'wx',0o644);try{await f.writeFile(token+'\n');}finally{await f.close();}cachedToken=token;return token;}
 catch(e:any){if(e?.code==='EEXIST'){cachedToken=(await readFile(file,'utf8')).trim();return cachedToken;}throw e;}
}
export const hostConfigured=()=>!!hostUrl();

export async function hostHealth():Promise<{ok:boolean;version?:string;sandbox?:string;error?:string}>{
 if(!hostUrl())return {ok:false,error:'The plugin host is not configured for this installation (PLUGIN_HOST_URL).'};
 try{
  const r=await fetch(`${hostUrl()}/health`,{signal:AbortSignal.timeout(3000)});
  if(!r.ok)return {ok:false,error:`The plugin host answered ${r.status}`};
  const body:any=await r.json();return {ok:true,version:body.version,sandbox:body.sandbox};
 }catch(e:any){return {ok:false,error:`The plugin host is not reachable (${e?.cause?.code||e?.message||'error'})`};}
}

export async function invokeHost(i:Invocation):Promise<HostResult>{
 if(!hostUrl())throw new HostUnavailable('The plugin host is not configured for this installation.');
 const send=async(withCode:boolean)=>{
  const body={sha:i.sha,...(withCode?{code:i.code}:{}),method:i.method,args:i.args,settings:i.settings,storage:i.storage,storageAllowed:i.storageAllowed,network:i.network,plugin:i.plugin,...(i.limits?{limits:i.limits}:{})};
  try{
   return await fetch(`${hostUrl()}/invoke`,{method:'POST',headers:{authorization:`Bearer ${await hostToken()}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(40_000)});
  }catch(e:any){throw new HostUnavailable(`The plugin host is not reachable (${e?.cause?.code||e?.message||'error'})`);}
 };
 let r=await send(false);
 if(r.status===409)r=await send(true);
 if(r.status===401)throw new HostUnavailable('The plugin host rejected the panel’s credentials. Restart both services so they share a token.');
 if(r.status===503)throw new HostUnavailable('The plugin host is busy; try again in a moment.');
 if(r.status>=500)throw new HostUnavailable('The plugin host failed to run the plugin.');
 if(!r.ok)throw new HostUnavailable(`The plugin host answered ${r.status}`);
 return await r.json() as HostResult;
}
