import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,asId,enqueue,audit} from './core.js';
import {settings} from './settings.js';
import {getRelease,newer,parse} from './updates.js';

// Agent release lookup. Binaries are named fledge-agent_linux_<arch> and listed in SHA256SUMS,
// either on the GitHub release of the configured repository or under a custom base URL.
type Release={version:string;base:string;sums:Record<string,string>;checkedAt:string};
let cached:{at:number;key:string;value:Release}|undefined;
const arches=['amd64','arm64'];

async function fetchText(url:string,token?:string){
 const r=await fetch(url,{headers:{'user-agent':'Fledge-agent-update',...(token?{authorization:`Bearer ${token}`}:{})},signal:AbortSignal.timeout(8000),redirect:'follow'});
 if(!r.ok)throw new Error(`${new URL(url).host} answered ${r.status}`);
 return (await r.text()).slice(0,64*1024);
}
export async function agentRelease(force=false):Promise<Release>{
 const cfg=(await settings()).agentUpdates,up=(await settings()).updates;
 const key=JSON.stringify([cfg.source,cfg.baseUrl,up.repository]);
 if(!force&&cached&&cached.key===key&&Date.now()-cached.at<5*60_000)return cached.value;
 let version:string,base:string;
 if(cfg.source==='url'){
  base=cfg.baseUrl;
  version=(await fetchText(`${base}/VERSION`)).trim().replace(/^v/i,'');
 }else{
  const rel=await getRelease(force);
  if(rel.error||!rel.latestVersion)throw new Error(rel.error||'No release found');
  version=rel.latestVersion;
  base=`https://github.com/${up.repository}/releases/download/v${version}`;
 }
 if(!parse(version))throw new Error(`“${version}” is not a version number`);
 const sums:Record<string,string>={};
 for(const line of (await fetchText(`${base}/SHA256SUMS`,cfg.source==='github'?up.githubToken:undefined)).split('\n')){const m=/^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line.trim());if(m)sums[m[2]]=m[1].toLowerCase();}
 const value={version,base,sums,checkedAt:new Date().toISOString()};
 cached={at:Date.now(),key,value};
 return value;
}

type NodeRow={id:string;name:string;status:string;version:string|null;agent:any};
function describe(n:NodeRow,rel:Release|null){
 const arch=n.agent?.arch,file=`fledge-agent_linux_${arch}`;
 const available=!!rel&&!!n.version&&newer(rel.version,n.version);
 let blocker:string|null=null;
 if(n.status!=='connected')blocker='Node is offline';
 else if(!n.agent?.updatable)blocker=n.agent?.updateBlocker||'This agent cannot update itself (reconnect it once with the latest connect script)';
 else if(rel&&!rel.sums[file])blocker=`The release has no ${arch||'matching'} build`;
 return {id:n.id,name:n.name,version:n.version,arch:arch||null,status:n.status,available,blocker,pending:false};
}
async function pendingNodes(){return new Set((await pool.query("SELECT DISTINCT node_id FROM jobs WHERE kind='agent.update' AND state IN ('queued','running')")).rows.map(r=>r.node_id));}

export async function queueUpdate(nodeId:string,rel:Release,actor:string|null){
 const n=(await pool.query("SELECT id,name,status,version,agent FROM nodes WHERE id=$1 AND deleted_at IS NULL",[nodeId])).rows[0];
 if(!n)fail(404,'Node not found');
 const d=describe(n,rel);
 if(!d.available)fail(409,'This agent is already up to date');
 if(d.blocker)fail(409,d.blocker);
 if((await pendingNodes()).has(nodeId))fail(409,'An update is already in progress for this node');
 const file=`fledge-agent_linux_${n.agent.arch}`;
 const job=await enqueue(nodeId,null,'agent.update',{version:rel.version,url:`${rel.base}/${file}`,sha256:rel.sums[file],from:n.version});
 await audit(actor,'agent.update','node',nodeId,{from:n.version,to:rel.version});
 return job;
}

export function agentUpdateRoutes(app:FastifyInstance){
 app.get('/api/agent-releases',async(req)=>{
  admin(req);
  let rel:Release|null=null,error:string|null=null;
  try{rel=await agentRelease((req.query as any)?.refresh==='1');}catch(e:any){error=`Could not check for agent releases: ${e?.message||'unknown error'}`;}
  const nodes=(await pool.query("SELECT id,name,status,version,agent FROM nodes WHERE deleted_at IS NULL ORDER BY name")).rows;
  const pending=await pendingNodes(),cfg=(await settings()).agentUpdates;
  return {latest:rel?.version||null,checkedAt:rel?.checkedAt||null,error,source:cfg.source,auto:cfg.auto,nodes:nodes.map(n=>({...describe(n,rel),pending:pending.has(n.id)}))};
 });
 app.post('/api/nodes/agent-update',async(req)=>{
  admin(req);
  const rel=await agentRelease(true),nodes=(await pool.query("SELECT id,name,status,version,agent FROM nodes WHERE deleted_at IS NULL")).rows,pending=await pendingNodes();
  const queued:string[]=[];
  for(const n of nodes){const d=describe(n,rel);if(d.available&&!d.blocker&&!pending.has(n.id)){await queueUpdate(n.id,rel,req.actor!.id);queued.push(n.id);}}
  return {version:rel.version,queued:queued.length};
 });
 app.post('/api/nodes/:id/agent-update',async(req)=>{
  admin(req);
  const rel=await agentRelease(true),job=await queueUpdate(asId((req.params as any).id),rel,req.actor!.id);
  return {jobId:job.id,version:rel.version};
 });
}

// With automatic updates on, outdated connected nodes are queued once per version.
export async function sweepAgentUpdates(){
 if(!(await settings()).agentUpdates.auto)return;
 let rel:Release;try{rel=await agentRelease();}catch{return;}
 const nodes=(await pool.query("SELECT id,name,status,version,agent FROM nodes WHERE deleted_at IS NULL AND status='connected'")).rows,pending=await pendingNodes();
 for(const n of nodes){
  const d=describe(n,rel);if(!d.available||d.blocker||pending.has(n.id))continue;
  const recent=(await pool.query("SELECT 1 FROM jobs WHERE node_id=$1 AND kind='agent.update' AND payload->>'version'=$2 AND state='failed' LIMIT 1",[n.id,rel.version])).rowCount;
  if(recent)continue; // don't retry a failed version in a loop
  try{await queueUpdate(n.id,rel,null);}catch{}
 }
}
