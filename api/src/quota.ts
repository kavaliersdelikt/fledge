import {fail} from './core.js';
import {checkLimits,usageOf as usageOfV2} from './limits.js';

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
/** Customer usage (the 0.6.x shape plus the new counters). */
export const usageOf=usageOfV2;

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

/** Throws 409 when the customer’s limits would be exceeded. Now backed by the layered limits engine (limits.ts). */
export async function enforceQuota(ownerId:string,delta:Partial<Usage>&{backupMb?:number},opts:{db?:Db;excludeServerId?:string;force?:boolean;actorIsAdmin?:boolean;planBacked?:boolean;change?:import('./limits.js').Change}={}){
 await checkLimits(ownerId,{servers:delta.servers,memoryMb:delta.memoryMb,cpuPercent:delta.cpuPercent,diskMb:delta.diskMb,backups:delta.backups,extraPorts:delta.extraPorts,backupMb:delta.backupMb,...(opts.change||{})},
  {db:opts.db,excludeServerId:opts.excludeServerId,force:opts.force,actorIsAdmin:opts.actorIsAdmin,planBacked:opts.planBacked});
}
