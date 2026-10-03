import type {FastifyInstance} from 'fastify';
import {pool,audit,withAdvisoryLock} from '../core.js';
import {settings} from '../settings.js';
import {activeProvider,provider,type WebhookEvent} from './provider.js';
import {completeOrder,syncSubscription,applyInvoice,handleDispute,loadSub} from './engine.js';

// The webhook inbox. A provider calls POST /api/billing/webhooks/<provider>; the payment plugin
// checks the signature; every event is stored (unique per provider and event id) and the
// request is answered. A worker then processes the events, retrying with backoff, and the
// result of an event is always "ask the provider what is true now", so duplicates, delays and
// reordering cannot corrupt anything.

const MAX_ATTEMPTS=20;
const backoffSeconds=(attempt:number)=>Math.min(12*3600,5*2**Math.min(attempt,13));
const HIDE=new Set(['cookie','authorization','proxy-authorization','x-forwarded-for','x-real-ip','host','connection']);

export async function webhookRoutes(app:FastifyInstance){
 await app.register(async inst=>{
  // The signature covers the exact bytes, so this route keeps the body as it arrived.
  inst.removeAllContentTypeParsers();
  inst.addContentTypeParser('*',{parseAs:'buffer',bodyLimit:512*1024},(_req,body,done)=>done(null,body));
  inst.post('/api/billing/webhooks/:provider',async(req,reply)=>{
   const p=await activeProvider();
   if(!p||p.id!==(req.params as any).provider){reply.code(p?404:503);return {error:p?'unknown_provider':'payments_unavailable'};}
   const body=Buffer.isBuffer(req.body)?req.body.toString('utf8'):'';
   if(!body){reply.code(400);return {error:'empty_body'};}
   const headers:Record<string,string>={};
   for(const [k,v] of Object.entries(req.headers))if(!HIDE.has(k)&&typeof v==='string')headers[k.toLowerCase()]=v.slice(0,1000);
   let result;
   try{result=await provider.webhook({body,headers});}
   catch(e:any){req.log.error(e,'payment plugin could not read a webhook');reply.code(503);return {error:'plugin_failed'};}
   if(!result.ok){reply.code(400);return {error:'invalid_signature'};}
   let stored=0;
   for(const ev of (result.events||[]).slice(0,50)){
    if(!ev||typeof ev.id!=='string'||typeof ev.type!=='string'||ev.kind==='ignore')continue;
    const refs={...ev.refs,kind:ev.kind,...(ev.won!==undefined?{won:ev.won}:{})};
    const r=await pool.query('INSERT INTO billing_events(provider,event_id,type,livemode,refs) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider,event_id) DO NOTHING',[p.id,ev.id.slice(0,120),ev.type.slice(0,120),!!ev.livemode,JSON.stringify(refs)]);
    stored+=r.rowCount||0;
   }
   // Acknowledge now; processing happens in the background (and again from the sweeper if this process dies).
   if(stored)setImmediate(()=>{processInbox().catch(e=>console.error('Webhook processing failed:',e?.message));});
   return {received:stored};
  });
 });
}

/**
 * An event can arrive before the checkout that created its subscription has been processed.
 * If the provider says the subscription belongs to a Fledge order, wait and try again for a while;
 * if it does not, it is someone else's subscription on the same account and is ignored.
 */
async function unknownSubscription(row:any,providerSubId:string){
 const snap=(await provider.reconcile({subscriptionId:providerSubId}).catch(()=>({subscription:null}))).subscription;
 const ours=!!snap?.metadata?.fledge_order;
 if(ours&&Date.now()-new Date(row.received_at).getTime()<10*60000)throw new Error('the subscription is not saved yet');
}

async function handle(row:any){
 const refs=row.refs||{};
 const meta={reason:`webhook ${row.type}`,source:'webhook' as const,ref:row.event_id};
 switch(refs.kind){
  case 'checkout':{
   const o=(await pool.query('SELECT id FROM orders WHERE provider=$1 AND provider_session_id=$2',[row.provider,refs.sessionId])).rows[0];
   // The order may still be being saved; retry for a few minutes before concluding it is not ours.
   if(!o){if(Date.now()-new Date(row.received_at).getTime()<10*60000)throw new Error('order not found yet');return;}
   await completeOrder(o.id,meta);return;
  }
  case 'subscription':{
   if(!refs.subscriptionId)return;
   if(!(await pool.query('SELECT 1 FROM subscriptions WHERE provider_subscription_id=$1',[refs.subscriptionId])).rowCount)return unknownSubscription(row,refs.subscriptionId);
   await syncSubscription({providerSubscriptionId:refs.subscriptionId},meta);
   return;
  }
  case 'invoice':
  case 'refund':{
   if(!refs.invoiceId)return;
   const r=await provider.reconcile({invoiceId:refs.invoiceId});
   const inv=r.invoice;
   if(!inv)return;
   const providerSub=inv.subscriptionId||refs.subscriptionId;
   const sub=providerSub?(await pool.query('SELECT id FROM subscriptions WHERE provider_subscription_id=$1',[providerSub])).rows[0]:null;
   if(!sub){if(providerSub)await unknownSubscription(row,providerSub);return;} // otherwise: an invoice for something Fledge did not sell
   const before=await loadSub(sub.id);
   await applyInvoice(inv,before);
   if(refs.kind==='invoice')await syncSubscription({id:sub.id},meta);
   return;
  }
  case 'dispute_opened':
  case 'dispute_closed':{
   const sub=refs.subscriptionId?(await pool.query('SELECT id FROM subscriptions WHERE provider_subscription_id=$1',[refs.subscriptionId])).rows[0]:null;
   if(sub)await handleDispute({id:row.event_id,type:row.type,kind:refs.kind,livemode:row.livemode,refs,won:refs.won} as WebhookEvent,await loadSub(sub.id));
   return;
  }
 }
}

/** Works through stored events that are due. Several API replicas may call this; rows are claimed one by one. */
export async function processInbox(limit=25){
 const rows=(await pool.query(`UPDATE billing_events SET attempts=attempts+1,next_attempt_at=now()+interval '5 minutes'
  WHERE id IN (SELECT id FROM billing_events WHERE processed_at IS NULL AND next_attempt_at<=now() AND attempts<$1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`,[MAX_ATTEMPTS,limit])).rows;
 for(const row of rows){
  try{
   await handle(row);
   await pool.query('UPDATE billing_events SET processed_at=now(),error=NULL WHERE id=$1',[row.id]);
  }catch(e:any){
   const message=String(e?.message||'error').slice(0,300);
   await pool.query("UPDATE billing_events SET error=$2,next_attempt_at=now()+make_interval(secs=>$3) WHERE id=$1",[row.id,message,backoffSeconds(row.attempts)]);
   if(row.attempts>=MAX_ATTEMPTS)await audit(null,'billing.event.gave_up','billing_event',String(row.id),{type:row.type,error:message}).catch(()=>{});
  }
 }
 return rows.length;
}

export async function sweepInbox(){
 await withAdvisoryLock(727311,async()=>{
  await processInbox(50);
  await pool.query("DELETE FROM billing_events WHERE processed_at IS NOT NULL AND processed_at<now()-interval '60 days'");
 });
}

export async function inboxHealth(){
 const q=(await pool.query(`SELECT count(*) FILTER (WHERE processed_at IS NULL)::int pending,
   count(*) FILTER (WHERE processed_at IS NULL AND attempts>=$1)::int stuck,
   count(*) FILTER (WHERE processed_at IS NULL AND error IS NOT NULL)::int failing,
   max(received_at) AS last_received,
   min(received_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending
   FROM billing_events`,[MAX_ATTEMPTS])).rows[0];
 return {pending:q.pending,stuck:q.stuck,failing:q.failing,lastReceivedAt:q.last_received,oldestPendingAt:q.oldest_pending};
}
void settings;
