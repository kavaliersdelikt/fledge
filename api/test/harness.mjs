// Shared helpers for the integration tests: spawn the API (and plugin host) as real
// processes against a throw-away PostgreSQL database and talk to them over HTTP.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {authenticator} from 'otplib';
import pg from 'pg';

const here=dirname(fileURLToPath(import.meta.url));
export const apiDir=join(here,'..');
export const repoDir=join(apiDir,'..');
export const baseDb=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL||'postgres://fledge:testpw@127.0.0.1:55432/fledge';

export async function freshDatabase(name){
 const admin=new pg.Client({connectionString:baseDb});await admin.connect();
 await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.query(`CREATE DATABASE ${name}`);await admin.end();
 const url=new URL(baseDb);url.pathname='/'+name;return url.toString();
}
export function startProcess(label,cwd,file,env,{quiet=true}={}){
 const child=spawn(process.execPath,['--import','tsx',file],{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
 let log='';
 for(const s of [child.stdout,child.stderr])s.on('data',d=>{log+=d;if(!quiet)process.stdout.write(`[${label}] ${d}`);});
 child.logs=()=>log.split(String.fromCharCode(10)).filter(l=>!l.startsWith('{')||/"level":(4|5)\d/.test(l)).join(String.fromCharCode(10));
 return child;
}
export async function waitFor(url,ms=40000){
 const end=Date.now()+ms;
 while(Date.now()<end){try{const r=await fetch(url);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}
 throw Error('Timed out waiting for '+url);
}
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/** A tiny HTTP client that keeps one session cookie, like a browser tab. */
export function client(base){
 const state={cookie:'',count:0};
 async function call(method,path,body,headers={}){
  const response=await fetch(base+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(state.cookie?{cookie:state.cookie}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined});
  const set=response.headers.get('set-cookie');if(set)state.cookie=set.split(';')[0];
  let data;const text=await response.text();try{data=text?JSON.parse(text):null;}catch{data=text;}
  return {code:response.status,data,headers:response.headers};
 }
 const ok=(r,label)=>{if(r.code<200||r.code>=300)throw Error(`${label}: ${r.code} ${JSON.stringify(r.data)}`);state.count++;return r.data;};
 const status=(r,code,label)=>{if(r.code!==code)throw Error(`${label}: expected ${code}, got ${r.code}: ${JSON.stringify(r.data)}`);state.count++;return r.data;};
 const check=(cond,label)=>{if(!cond)throw Error('assertion failed: '+label);state.count++;};
 return {call,ok,status,check,state,get cookie(){return state.cookie;},set cookie(v){state.cookie=v;}};
}
export async function bootstrapAdmin(c,prefix='admin'){
 const password=randomBytes(20).toString('base64url'),email=`${prefix}-${randomBytes(4).toString('hex')}@example.test`;
 c.ok(await c.call('POST','/api/auth/bootstrap',{email,password}),'bootstrap');
 const setup=c.ok(await c.call('POST','/api/auth/2fa/setup',{}),'2fa setup');
 c.ok(await c.call('POST','/api/auth/2fa/confirm',{code:authenticator.generate(setup.secret)}),'2fa confirm');
 return {email,password,secret:setup.secret};
}
export async function makeNode(c,name,location='test',extra={}){
 const n=c.ok(await c.call('POST','/api/nodes',{name,location,memoryMb:8192,cpuPercent:800,diskMb:100000,headroomMb:256,...extra}),'node create');
 const t=c.ok(await c.call('POST',`/api/nodes/${n.id}/enrollment`,{}),'enrollment');
 const enrolled=c.ok(await c.call('POST','/api/agent/enroll',{nodeId:n.id,token:t.token}),'enroll');
 const headers={authorization:'Bearer '+enrolled.credential,'x-node-id':n.id};
 return {id:n.id,name,headers};
}
export async function heartbeat(c,node,version='0.6.1.1',servers=[]){return c.ok(await c.call('POST','/api/agent/heartbeat',{version,servers,agent:{os:'linux',arch:'amd64',updatable:true}},node.headers),'heartbeat');}
/** Plays the node agent: take the next job (if any) and report a result. */
export async function nextJob(c,node){const r=c.ok(await c.call('GET','/api/agent/jobs',undefined,node.headers),'poll');return r.job;}
export async function finishJob(c,node,job,success=true,result={},error){
 return c.ok(await c.call('POST',`/api/agent/jobs/${job.id}/result`,{attempt:job.attempt,success,result,...(error?{error}:{})},node.headers),'job result');
}

/** Boots mock Modrinth + plugin host + API. Returns handles and a stop() function. */
export async function bootStack({db,apiPort,hostPort,mock,apiEnv={},quiet=true}){
 const dir=mkdtempSync(join(tmpdir(),'fledge-plugin-test-'));
 const tokenFile=join(dir,'token');
 const databaseUrl=await freshDatabase(db);
 const map=mock?`api.modrinth.com=127.0.0.1:${mock.port},cdn.modrinth.com=127.0.0.1:${mock.port}`:'';
 const host=startProcess('host',join(repoDir,'plugins','host'),'src/server.ts',{PORT:String(hostPort),PLUGIN_TOKEN_FILE:tokenFile,PLUGIN_HOST_UNSAFE_TEST_ALLOW_LOCAL:'1',PLUGIN_HOST_UNSAFE_TEST_HOST_MAP:map,APP_VERSION:'0.6.2.1'},{quiet});
 // The API creates the shared token file on first use; start it first so the host can read it.
 const api=startProcess('api',apiDir,'src/index.ts',{DATABASE_URL:databaseUrl,ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',WEB_ORIGIN:'http://localhost:3000',PORT:String(apiPort),APP_VERSION:'0.6.2.1',PLUGIN_HOST_URL:`http://127.0.0.1:${hostPort}`,PLUGIN_TOKEN_FILE:tokenFile,FLEDGE_TEST_ALLOW_LOCAL_FETCH:'1',...apiEnv},{quiet});
 await waitFor(`http://127.0.0.1:${apiPort}/api/health`);
 await waitFor(`http://127.0.0.1:${hostPort}/health`);
 const stop=async()=>{for(const p of [api,host])p.kill();await sleep(300);};
 return {api,host,base:`http://127.0.0.1:${apiPort}`,databaseUrl,stop,tokenFile};
}
export async function dbQuery(databaseUrl,sql,args=[]){const c=new pg.Client({connectionString:databaseUrl});await c.connect();try{return (await c.query(sql,args)).rows;}finally{await c.end();}}
