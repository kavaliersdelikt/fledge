import type {FastifyInstance} from 'fastify';
import {pool,fail,serverAccess} from './core.js';

// Resource history. Heartbeats carry a CPU/memory sample per server every few seconds; they are
// averaged in memory per minute and written as three resolutions so charts for a day, a week and
// a month stay cheap: 1-minute buckets kept 24 h, 5-minute kept 7 days, hourly kept 30 days.

type Acc={minute:number;cpuSum:number;cpuMax:number;memSum:number;memMax:number;n:number;disk:number|null};
const live=new Map<string,Acc>();
const RES:[number,number][]=[[1,60_000],[2,300_000],[3,3_600_000]];

export function recordSample(serverId:string,s:{cpuPercent:number;memoryBytes:number;diskBytes?:number|null},now=Date.now()){
 const minute=Math.floor(now/60_000)*60_000,cur=live.get(serverId);
 if(cur&&cur.minute!==minute)void flushOne(serverId,cur).catch(()=>{});
 const a=cur&&cur.minute===minute?cur:{minute,cpuSum:0,cpuMax:0,memSum:0,memMax:0,n:0,disk:null};
 a.cpuSum+=s.cpuPercent;a.cpuMax=Math.max(a.cpuMax,s.cpuPercent);a.memSum+=s.memoryBytes;a.memMax=Math.max(a.memMax,s.memoryBytes);a.n++;
 if(typeof s.diskBytes==='number')a.disk=s.diskBytes;
 live.set(serverId,a);
}
async function flushOne(serverId:string,a:Acc){
 for(const [res,size] of RES){
  const bucket=new Date(Math.floor(a.minute/size)*size);
  await pool.query(`INSERT INTO server_metrics(server_id,res,bucket,cpu_sum,cpu_max,mem_sum,mem_max,disk_bytes,n) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT(server_id,res,bucket) DO UPDATE SET cpu_sum=server_metrics.cpu_sum+EXCLUDED.cpu_sum,cpu_max=GREATEST(server_metrics.cpu_max,EXCLUDED.cpu_max),mem_sum=server_metrics.mem_sum+EXCLUDED.mem_sum,mem_max=GREATEST(server_metrics.mem_max,EXCLUDED.mem_max),disk_bytes=COALESCE(EXCLUDED.disk_bytes,server_metrics.disk_bytes),n=server_metrics.n+EXCLUDED.n`,
   [serverId,res,bucket,a.cpuSum,a.cpuMax,a.memSum,a.memMax,a.disk,a.n]);
 }
}
/** Writes finished minutes (all of them with force) and trims old rows. */
export async function flushMetrics(force=false,only?:string){
 const current=Math.floor(Date.now()/60_000)*60_000;
 for(const [id,a] of [...live]){
  if(only&&id!==only)continue;
  if(force||a.minute<current){live.delete(id);await flushOne(id,a).catch(e=>console.error('metrics flush failed:',e?.message));}
 }
}
export async function trimMetrics(){
 await pool.query("DELETE FROM server_metrics WHERE (res=1 AND bucket<now()-interval '26 hours') OR (res=2 AND bucket<now()-interval '8 days') OR (res=3 AND bucket<now()-interval '31 days')");
}

const RANGES:Record<string,{res:number;ms:number}>={'1h':{res:1,ms:3_600_000},'6h':{res:1,ms:6*3_600_000},'24h':{res:1,ms:24*3_600_000},'7d':{res:2,ms:7*86_400_000},'30d':{res:3,ms:30*86_400_000}};
export function metricsRoutes(app:FastifyInstance){
 app.get('/api/servers/:id/metrics',async(req)=>{
  const s=await serverAccess(req,(req.params as any).id);
  const range=String((req.query as any)?.range||'1h'),r=RANGES[range];
  if(!r)fail(400,'range must be 1h, 6h, 24h, 7d or 30d');
  await flushMetrics(true,s.id);
  const rows=(await pool.query("SELECT bucket,cpu_sum,cpu_max,mem_sum,mem_max,disk_bytes,n FROM server_metrics WHERE server_id=$1 AND res=$2 AND bucket>=$3 ORDER BY bucket",[s.id,r.res,new Date(Date.now()-r.ms)])).rows;
  return {range,resolutionSeconds:r.res===1?60:r.res===2?300:3600,memoryLimitBytes:s.memory_mb*1048576,points:rows.map((p:any)=>({t:new Date(p.bucket).getTime(),cpu:p.n?Math.round(p.cpu_sum/p.n*10)/10:0,cpuMax:Math.round(p.cpu_max*10)/10,memory:p.n?Math.round(p.mem_sum/p.n):0,memoryMax:Math.round(p.mem_max),disk:p.disk_bytes===null?null:Number(p.disk_bytes),samples:p.n}))};
 });
}
