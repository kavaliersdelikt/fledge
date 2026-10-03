import {pool,fail,audit} from '../core.js';
import {settings} from '../settings.js';
import {formatMoney,INTERVALS,type Interval} from '../money.js';
import {provider} from './provider.js';
import {availability} from './plans.js';
import {loadSub,serverOf,syncSubscription,mailSub,moveTo,type Meta} from './engine.js';

// Moving a subscription to another plan or interval. The provider prorates the money; the
// server is resized to the new preset. Everything that could go wrong is checked before the
// provider is told anything, so a refused change never leaves half a change behind.

type Opts={source:Meta['source'];actor:string|null;customer?:boolean;dryRun?:boolean};

export async function changePlan(subId:string,newPlanId:string,cycle:Interval,opts:Opts){
 const sub=await loadSub(subId);
 if(!sub)fail(404,'Subscription not found');
 if(!['trialing','active'].includes(sub.status))fail(409,'Only a subscription that is up to date can be changed.');
 const cfg=(await settings()).billing;
 if(sub.provider==='manual'&&opts.customer)fail(403,'This subscription was granted by the provider. Contact support to change it.');
 const plan=(await pool.query(opts.customer?"SELECT * FROM plans WHERE id=$1 AND active AND archived_at IS NULL AND visibility IN ('public','hidden')":'SELECT * FROM plans WHERE id=$1',[newPlanId])).rows[0];
 if(!plan)fail(404,'That plan is not available.');
 if(plan.kind!==sub.plan_kind)fail(400,'This plan is a different kind of product. Start a new subscription instead.');
 const price=(await pool.query('SELECT * FROM plan_prices WHERE plan_id=$1 AND cycle=$2 AND currency=$3 AND active',[plan.id,cycle,sub.currency])).rows[0];
 if(!price)fail(400,`That option is not offered in ${String(sub.currency).toUpperCase()}.`);
 if(plan.id===sub.plan_id&&price.cycle===sub.cycle)fail(400,'You are already on this plan.');
 if(plan.id!==sub.plan_id){const av=await availability(plan);if(av.soldOut)fail(409,'That plan is sold out right now.');}

 let resize:null|{memoryMb:number;cpuPercent:number;diskMb:number;serverId:string;nodeId:string}=null,smaller=false;
 if(plan.kind==='server'){
  const oldP=sub.preset||{},newP=plan.preset||{};
  if(oldP.templateId!==newP.templateId)fail(400,'This plan runs a different kind of server. Start a new subscription instead.');
  const srv=await serverOf(sub.id);
  if(!srv)fail(409,'Your server is not ready yet. Try again in a moment.');
  smaller=newP.memoryMb<srv.memory_mb||newP.cpuPercent<srv.cpu_percent||newP.diskMb<srv.disk_mb;
  if(smaller&&!cfg.allowDowngrade&&opts.customer)fail(403,'Moving to a smaller plan is turned off. Contact support.');
  const used=Number(srv.usage?.diskBytes);
  if(newP.diskMb<srv.disk_mb&&Number.isFinite(used)&&used+16*1048576>newP.diskMb*1048576)fail(409,`The server uses ${Math.ceil(used/1048576)} MB of disk. Free some space before moving to a plan with less.`);
  const node=(await pool.query('SELECT * FROM nodes WHERE id=$1',[srv.node_id])).rows[0];
  const other=(await pool.query('SELECT coalesce(sum(memory_mb),0) mem,coalesce(sum(cpu_percent),0) cpu,coalesce(sum(disk_mb),0) disk FROM servers WHERE node_id=$1 AND deleted_at IS NULL AND id<>$2',[srv.node_id,srv.id])).rows[0];
  if(Number(other.mem)+newP.memoryMb>node.memory_mb-node.headroom_mb||Number(other.cpu)+newP.cpuPercent>node.cpu_percent||Number(other.disk)+newP.diskMb>node.disk_mb)fail(409,'The machine your server runs on has no room for the bigger plan right now. Please contact support.');
  resize={memoryMb:newP.memoryMb,cpuPercent:newP.cpuPercent,diskMb:newP.diskMb,serverId:srv.id,nodeId:srv.node_id};
 }
 const summary={from:{plan:sub.plan_name,cycle:sub.cycle,amountText:formatMoney(sub.amount,sub.currency)},to:{plan:plan.name,cycle:price.cycle,amountText:formatMoney(price.amount,price.currency)},
  prorated:sub.provider!=='manual',restart:!!resize,smaller,note:sub.provider==='manual'?'':'The difference is charged or credited for the rest of the current period.'};
 if(opts.dryRun)return summary as any;

 if(sub.provider!=='manual'&&sub.provider_subscription_id){
  await provider.changePlan({subscriptionId:sub.provider_subscription_id,itemName:plan.name,amount:Number(price.amount),currency:price.currency,cycle:price.cycle,prorate:true});
 }
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sub:'+sub.id]);
  await c.query('UPDATE subscriptions SET plan_id=$2,price_id=$3,cycle=$4,amount=$5,version=version+1,updated_at=now() WHERE id=$1',[sub.id,plan.id,price.id,price.cycle,price.amount]);
  if(resize){
   await c.query('UPDATE servers SET memory_mb=$2,cpu_percent=$3,disk_mb=$4,updated_at=now() WHERE id=$1',[resize.serverId,resize.memoryMb,resize.cpuPercent,resize.diskMb]);
   await c.query("INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,'configure',$3)",[resize.nodeId,resize.serverId,JSON.stringify({recreate:false})]);
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 await audit(opts.actor,'billing.change','subscription',sub.id,{from:sub.plan_id,to:plan.id,cycle:price.cycle});
 if(sub.provider!=='manual')await syncSubscription({id:sub.id},{reason:'plan changed',source:opts.source}).catch(()=>{});
 else await moveTo(sub.id,sub.status,{reason:'plan changed',source:opts.source},{});
 const after=await loadSub(sub.id);
 if(after)await mailSub(after,'plan_changed',{oldPlanName:sub.plan_name,effective:'now'},`chg:${after.version}`);
 return after;
}
void INTERVALS;
