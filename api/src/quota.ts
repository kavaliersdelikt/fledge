import {pool,fail} from './core.js';

// Per-customer limits. A missing or null field means "no limit". Limits apply to what the
// customer owns (servers, reserved resources, backups, extra ports); admins may exceed them
// deliberately with `force`.

export type Quota={maxServers?:number|null;maxMemoryMb?:number|null;maxCpuPercent?:number|null;maxDiskMb?:number|null;maxBackups?:number|null;maxExtraPorts?:number|null};
export type Usage={servers:number;memoryMb:number;cpuPercent:number;diskMb:number;backups:number;extraPorts:number};
const FIELDS:[keyof Quota,keyof Usage,string][]=[['maxServers','servers','servers'],['maxMemoryMb','memoryMb','memory (MB)'],['maxCpuPercent','cpuPercent','CPU (%)'],['maxDiskMb','diskMb','disk (MB)'],['maxBackups','backups','backups'],['maxExtraPorts','extraPorts','extra ports']];

export function validateQuota(input:unknown):Quota{
 if(input===null)return {};
 if(typeof input!=='object'||Array.isArray(input))fail(400,'quota must be an object');
 const out:Quota={},body=input as Record<string,unknown>;
 for(const k of Object.keys(body))if(!FIELDS.some(f=>f[0]===k))fail(400,`Unknown quota field “${k.slice(0,40)}”`);
 for(const [k] of FIELDS){
  const v=body[k];
  if(v===undefined||v===null||v==='')continue;
  const n=Number(v);
  if(!Number.isInteger(n)||n<0||n>1e9)fail(400,`${k} must be a whole number from 0 to 1000000000, or empty for no limit`);
  out[k]=n;
 }
 return out;
}

type Db={query:(q:string,a?:any[])=>Promise<any>};
export async function usageOf(ownerId:string,db:Db=pool,excludeServerId?:string):Promise<Usage>{
 const s=(await db.query("SELECT count(*)::int servers,coalesce(sum(memory_mb),0)::int mem,coalesce(sum(cpu_percent),0)::int cpu,coalesce(sum(disk_mb),0)::int disk,coalesce(sum(jsonb_array_length(extra_ports)),0)::int ports FROM servers WHERE owner_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id<>$2)",[ownerId,excludeServerId||null])).rows[0];
 const b=(await db.query("SELECT count(*)::int n FROM backups b JOIN servers s ON s.id=b.server_id WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND b.state<>'failed'",[ownerId])).rows[0];
 return {servers:s.servers,memoryMb:s.mem,cpuPercent:s.cpu,diskMb:s.disk,backups:b.n,extraPorts:s.ports};
}

/** Returns a sentence describing the first limit the change would break, or null. */
export function quotaProblem(quota:Quota|null|undefined,usage:Usage,delta:Partial<Usage>):string|null{
 for(const [qk,uk,label] of FIELDS){
  const limit=quota?.[qk];
  if(limit===undefined||limit===null)continue;
  const add=delta[uk]||0;
  if(add>0&&usage[uk]+add>limit)return `This would exceed the customer’s limit of ${limit} ${label} (${usage[uk]} in use${add?`, ${add} requested`:''}).`;
 }
 return null;
}

/** Throws 409 when the customer’s limits would be exceeded. */
export async function enforceQuota(ownerId:string,delta:Partial<Usage>,opts:{db?:Db;excludeServerId?:string;force?:boolean}={}){
 if(opts.force)return;
 const db=opts.db||pool;
 // Inside a transaction the owner row is locked, so concurrent creates for one customer are checked one after another.
 const quota=(await db.query('SELECT quota FROM users WHERE id=$1'+(opts.db?' FOR UPDATE':''),[ownerId])).rows[0]?.quota as Quota|undefined;
 if(!quota||!Object.keys(quota).length)return;
 const problem=quotaProblem(quota,await usageOf(ownerId,db,opts.excludeServerId),delta);
 if(problem)fail(409,problem);
}
