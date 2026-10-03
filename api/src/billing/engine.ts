import {pool,audit,fail,enqueue,WEB_ORIGIN} from '../core.js';
import {settings} from '../settings.js';
import {sendTemplate,sendToAdmins} from '../email.js';
import {emit,notifyUser} from '../notifications.js';
import {provisionServer} from '../provision.js';
import {backupEnabled} from '../storage.js';
import {formatMoney,INTERVALS,addMonths,type Interval} from '../money.js';
import {canMove,mapProviderStatus,dunningActions,type Status,type Dunning} from './states.js';
import {provider,activeProvider,type SubSnapshot,type InvoiceSnapshot,type SessionSnapshot,type WebhookEvent} from './provider.js';

// The subscription engine: every change of a subscription's status, and everything that follows
// from it (starting or stopping the server, emails, notifications), happens here. The provider's
// webhooks are only nudges: the engine always asks the provider for the current state.

const origin=()=>WEB_ORIGIN.replace(/\/$/,'');
export const fmtDate=(d:Date|string|null|undefined)=>d?new Date(d).toUTCString().slice(5,16):'';
export type Meta={reason:string;source:'webhook'|'scheduler'|'admin'|'customer'|'system'|'reconcile';ref?:string;actor?:string|null};

export type SubRow=any;
export async function loadSub(id:string):Promise<SubRow|null>{
 return (await pool.query(`SELECT s.*,p.name AS plan_name,p.kind AS plan_kind,p.preset,p.retention_days AS plan_retention,p.options AS plan_options,u.email,u.status AS user_status
  FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN users u ON u.id=s.user_id WHERE s.id=$1`,[id])).rows[0]||null;
}
const holdsOf=(s:SubRow):{type:string;id?:string;at?:string}[]=>Array.isArray(s.holds)?s.holds:[];

// Columns a patch may touch. Anything else is a bug, not a request.
const PATCHABLE=new Set(['current_period_start','current_period_end','trial_end','cancel_at_period_end','past_due_since','suspended_at','canceled_at','ended_at','terminated_at','retention_until','amount','currency','provider_status','provider_customer_id','provider_subscription_id','fulfilment','fulfilment_attempts','fulfilment_error','next_fulfilment_at','server_details','dunning','holds','manual_ends_at','note','reconciled_at','price_id','plan_id','cycle','livemode']);

/**
 * Moves a subscription to a new status (or just patches it when the status stays). Locked per
 * subscription, checked against the transition table, recorded in subscription_events. Side
 * effects run after the transaction commits.
 */
export async function moveTo(subId:string,to:Status,meta:Meta,patch:Record<string,unknown>={}):Promise<{changed:boolean;sub:SubRow}|null>{
 const c=await pool.connect();
 let before:any;
 try{
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sub:'+subId]);
  before=(await c.query('SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE',[subId])).rows[0];
  if(!before){await c.query('ROLLBACK');return null;}
  if(!canMove(before.status,to)){
   await c.query('ROLLBACK');
   await audit(null,'billing.transition.ignored','subscription',subId,{from:before.status,to,reason:meta.reason}).catch(()=>{});
   return {changed:false,sub:await loadSub(subId)};
  }
  const cfg=(await settings()).billing;
  const set:Record<string,unknown>={...patch};
  const sql:string[]=[];
  if(to!==before.status){
   if(to==='past_due'&&!before.past_due_since)sql.push('past_due_since=now()');
   if(to==='active'||to==='trialing'){sql.push('past_due_since=NULL','suspended_at=NULL',"dunning='{}'::jsonb");if(before.status==='canceled')sql.push('ended_at=NULL','retention_until=NULL','canceled_at=NULL');}
   if(to==='suspended')sql.push('suspended_at=now()');
   if(to==='canceled'){
    const days=(await c.query('SELECT p.retention_days FROM plans p WHERE p.id=$1',[before.plan_id])).rows[0]?.retention_days;
    sql.push('ended_at=COALESCE(ended_at,now())','canceled_at=COALESCE(canceled_at,now())',`retention_until=now()+make_interval(days=>${Number(days??cfg.retentionDays)||0})`);
   }
   if(to==='terminated')sql.push('terminated_at=now()');
  }
  const cols=Object.keys(set).filter(k=>PATCHABLE.has(k));
  const args:any[]=[subId,to];
  const assigns=cols.map(k=>{args.push((k==='server_details'||k==='dunning'||k==='holds')&&typeof set[k]!=='string'?JSON.stringify(set[k]):set[k]);return `${k}=$${args.length}`;});
  // A column the caller sets explicitly is not also set by the automatic rules.
  const auto=sql.filter(x=>!cols.includes(x.split('=')[0]));
  await c.query(`UPDATE subscriptions SET status=$2,version=version+1,updated_at=now()${assigns.length?','+assigns.join(','):''}${auto.length?','+auto.join(','):''} WHERE id=$1`,args);
  if(to!==before.status)await c.query('INSERT INTO subscription_events(subscription_id,from_status,to_status,reason,source,ref) VALUES($1,$2,$3,$4,$5,$6)',[subId,before.status,to,meta.reason.slice(0,200),meta.source,meta.ref?String(meta.ref).slice(0,200):null]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 const after=await loadSub(subId);
 if(before.status!==to)await afterTransition(after,before.status as Status,to,meta).catch(e=>console.error('Billing follow-up failed:',(e as Error)?.message));
 return {changed:before.status!==to,sub:after};
}

// --- Emails ------------------------------------------------------------------------------------
function describe(s:SubRow){
 return {planName:s.plan_name,amount:formatMoney(s.amount,s.currency),interval:INTERVALS[s.cycle as Interval]?.adjective||s.cycle,billingUrl:`${origin()}/billing`,periodEnd:fmtDate(s.current_period_end)};
}
export async function mailSub(s:SubRow,template:string,extra:Record<string,string|number>={},key?:string){
 await sendTemplate(template,s.email,{...describe(s),...extra},{userId:s.user_id,dedupeKey:key?`${template}:${s.id}:${key}`:undefined}).catch(e=>console.error('Billing email failed:',(e as Error)?.message));
}
async function adminNotify(kind:string,title:string,body:string,template:string,vars:Record<string,string>,key:string){
 const cfg=(await settings()).billing;
 await emit({kind,title,body,severity:kind==='billing.dispute'||kind==='billing.fulfilment_failed'?'bad':'warn',dedupe:{key,minutes:60*12}});
 if(cfg.notifyAdmins)await sendToAdmins(template,vars,`${template}:${key}`).catch(()=>{});
}

// --- Server effects ----------------------------------------------------------------------------
export async function serverOf(subId:string){
 return (await pool.query("SELECT s.*,n.status AS node_status FROM servers s JOIN nodes n ON n.id=s.node_id WHERE s.subscription_id=$1 AND s.deleted_at IS NULL",[subId])).rows[0];
}
/** Stops the server and marks it as held for billing. Never overrides a reason that was already there. */
export async function holdServer(subId:string){
 const s=await serverOf(subId);
 if(!s)return;
 await pool.query("UPDATE servers SET suspended=true,desired_status='stopped',suspended_reason=COALESCE(suspended_reason,'billing') WHERE id=$1",[s.id]);
 if(s.node_status==='connected'&&s.observed_status!=='deleting')await enqueue(s.node_id,s.id,'stop');
}
/** Starts the server again, but only lifts a hold that billing itself placed. */
export async function releaseServer(sub:SubRow):Promise<boolean>{
 if(holdsOf(sub).length)return false;
 const s=await serverOf(sub.id);
 if(!s)return false;
 const r=await pool.query("UPDATE servers SET suspended=false,suspended_reason=NULL,desired_status='running',pending_delete_at=NULL WHERE id=$1 AND suspended_reason='billing' RETURNING id",[s.id]);
 if(!r.rowCount)return false;
 if(s.node_status==='connected')await enqueue(s.node_id,s.id,'start');
 return true;
}
/** Schedules the server for deletion shortly, after one last backup when backups exist. */
export async function terminateServer(sub:SubRow){
 const s=await serverOf(sub.id);
 if(!s)return;
 const cfg=(await settings()).billing;
 if(cfg.finalBackup&&await backupEnabled()&&s.node_status==='connected'){
  const key=`servers/${s.id}/backups/${crypto.randomUUID()}.tar.gz`;
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const b=(await c.query('INSERT INTO backups(server_id,object_key) VALUES($1,$2) RETURNING id',[s.id,key])).rows[0];
   const j=(await c.query("INSERT INTO jobs(node_id,server_id,kind,payload) VALUES($1,$2,'backup',$3) RETURNING id",[s.node_id,s.id,JSON.stringify({backupId:b.id})])).rows[0];
   await c.query('UPDATE backups SET job_id=$1 WHERE id=$2',[j.id,b.id]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});console.error('Final backup could not be queued:',(e as Error)?.message);}finally{c.release();}
 }
 // The backup runs during this window; then the owner-delete sweep removes the server.
 await pool.query("UPDATE servers SET suspended=true,desired_status='stopped',suspended_reason='billing-terminated',pending_delete_at=now()+interval '2 hours' WHERE id=$1",[s.id]);
 await audit(null,'billing.terminate','server',s.id,{subscriptionId:sub.id});
}

// --- What follows a change of status ---------------------------------------------------------------------
async function afterTransition(sub:SubRow,from:Status,to:Status,meta:Meta){
 const cfg=(await settings()).billing;
 await audit(null,'billing.status','subscription',sub.id,{from,to,reason:meta.reason,source:meta.source});
 if(to==='active'||to==='trialing'){
  if(from==='incomplete'||(from==='canceled'&&sub.fulfilment!=='done'))await fulfil(sub.id);
  else if(from==='past_due'||from==='suspended'||from==='canceled'){
   const resumed=await releaseServer(sub);
   if(resumed)await mailSub(sub,'server_resumed',{serverName:(await serverOf(sub.id))?.name||sub.plan_name},`resume:${sub.version}`);
  }
  return;
 }
 if(to==='past_due'){
  const due=new Date(sub.past_due_since||Date.now());
  await mailSub(sub,'payment_failed',{suspendDate:fmtDate(new Date(due.getTime()+cfg.suspendAfterDays*86400000)),retryDate:''},`failed:${fmtDate(due)}`);
  await emit({kind:'billing.payment_failed',title:`Payment failed for ${sub.email}`,body:`${sub.plan_name}: ${formatMoney(sub.amount,sub.currency)}`,severity:'warn',dedupe:{key:`pf:${sub.id}`,minutes:60*24}});
  return;
 }
 if(to==='suspended'){
  await holdServer(sub.id);
  const srv=await serverOf(sub.id);
  await mailSub(sub,'server_suspended_billing',{serverName:srv?.name||sub.plan_name},`susp:${fmtDate(sub.suspended_at)}`);
  return;
 }
 if(to==='canceled'){
  await holdServer(sub.id);
  const retention=sub.retention_until?fmtDate(sub.retention_until):'';
  await mailSub(sub,'subscription_ended',{retentionDate:retention},`ended:${fmtDate(sub.ended_at)}`);
  return;
 }
 if(to==='terminated'){await terminateServer(sub);return;}
}

// --- Fulfilment: turning a paid subscription into a server -------------------------------------------
/** Only one caller at a time creates the server for a subscription; others (a webhook, the customer's return, the retry sweep) just leave it to them. */
export async function fulfil(subId:string):Promise<void>{
 const lock=await pool.connect();
 try{
  if(!(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok',['fulfil:'+subId])).rows[0].ok)return;
  try{await fulfilLocked(subId);}finally{await lock.query('SELECT pg_advisory_unlock(hashtext($1))',['fulfil:'+subId]).catch(()=>{});}
 }finally{lock.release();}
}
async function fulfilLocked(subId:string):Promise<void>{
 const sub=await loadSub(subId);
 if(!sub)return;
 if(sub.plan_kind!=='server'){await patch(subId,{fulfilment:'done'});return;}
 if(sub.fulfilment==='done')return;
 const existing=await serverOf(sub.id);
 if(existing){await patch(subId,{fulfilment:'done',fulfilment_error:null});return;}
 const preset=sub.preset||{},details=sub.server_details||{};
 try{
  const locs=Array.isArray(preset.locations)&&preset.locations.length?preset.locations as string[]:null;
  const chosen=details.location&&(!locs||locs.includes(details.location))?String(details.location):null;
  const r=await provisionServer({ownerId:sub.user_id,templateId:preset.templateId,name:String(details.name||sub.plan_name).slice(0,80),location:chosen,locations:chosen?null:locs,
   memoryMb:preset.memoryMb,cpuPercent:preset.cpuPercent,diskMb:preset.diskMb,variables:{...(preset.variables||{}),...(details.variables||{})},
   actorId:null,actorIsAdmin:true,createdVia:'store',subscriptionId:sub.id,planBacked:true,friendlyErrors:true});
  await patch(subId,{fulfilment:'done',fulfilment_error:null,fulfilment_attempts:Number(sub.fulfilment_attempts)+1,next_fulfilment_at:null});
  await audit(null,'billing.fulfilled','subscription',sub.id,{serverId:r.server.id});
  await mailSub(sub,'server_ready',{serverName:r.server.name,serverUrl:`${origin()}/servers/${r.server.id}`},'ready');
 }catch(e:any){
  const attempts=Number(sub.fulfilment_attempts)+1;
  const message=String(e?.message||'unknown error').slice(0,300);
  const delayMin=Math.min(60,2**Math.min(attempts,6));
  await patch(subId,{fulfilment:'failed',fulfilment_attempts:attempts,fulfilment_error:message,next_fulfilment_at:new Date(Date.now()+delayMin*60000)});
  await audit(null,'billing.fulfilment.failed','subscription',sub.id,{attempts,error:message});
  if(attempts===1){
   await mailSub(sub,'provisioning_delayed',{},'delayed');
   await adminNotify('billing.fulfilment_failed',`A paid server for ${sub.email} could not be created`,message,'admin_fulfilment_failed',{customerEmail:sub.email,planName:sub.plan_name,error:message,link:`${origin()}/billing`},`ff:${sub.id}`);
  }
 }
}

/** Updates columns without changing the status. */
export async function patch(subId:string,fields:Record<string,unknown>){
 const cur=(await pool.query('SELECT status FROM subscriptions WHERE id=$1',[subId])).rows[0];
 if(!cur)return;
 await moveTo(subId,cur.status as Status,{reason:'patch',source:'system'},fields);
}

// --- Provider state -> our state ------------------------------------------------------------------------------
const iso=(v:string|null|undefined)=>v?new Date(v):null;
export async function applySubscription(sub:SubRow,snap:SubSnapshot,meta:Meta){
 const target=mapProviderStatus(sub.status as Status,snap.status);
 const fields:Record<string,unknown>={
  provider_status:snap.status,reconciled_at:new Date(),
  ...(snap.currentPeriodStart!==undefined?{current_period_start:iso(snap.currentPeriodStart)}:{}),
  ...(snap.currentPeriodEnd!==undefined?{current_period_end:iso(snap.currentPeriodEnd)}:{}),
  ...(snap.cancelAtPeriodEnd!==undefined?{cancel_at_period_end:!!snap.cancelAtPeriodEnd}:{}),
  ...(snap.trialEnd!==undefined?{trial_end:iso(snap.trialEnd)}:{}),
  ...(snap.customerId?{provider_customer_id:snap.customerId}:{}),
  ...(typeof snap.amount==='number'&&snap.amount>=0&&sub.provider!=='manual'?{amount:snap.amount}:{}),
  ...(snap.currency&&/^[a-z]{3}$/i.test(snap.currency)?{currency:snap.currency.toLowerCase()}:{}),
 };
 if(snap.canceledAt)fields.canceled_at=iso(snap.canceledAt);
 if(snap.endedAt)fields.ended_at=iso(snap.endedAt);
 if(typeof snap.livemode==='boolean')fields.livemode=snap.livemode;
 return moveTo(sub.id,target,meta,fields);
}

/** Records or updates an invoice the provider reported. A paid invoice produces the receipt, once. */
export async function applyInvoice(inv:InvoiceSnapshot,sub:SubRow|null){
 const userId=sub?.user_id||null;
 const prev=(await pool.query('SELECT status,amount_paid,amount_refunded FROM invoices WHERE provider=$1 AND provider_invoice_id=$2',[sub?.provider||'stripe',inv.id])).rows[0];
 const provName=sub?.provider||(await settings()).billing.provider||'stripe';
 void provName;
 await pool.query(`INSERT INTO invoices(subscription_id,user_id,provider,provider_invoice_id,number,status,amount_due,amount_paid,amount_refunded,currency,period_start,period_end,hosted_url,pdf_url,description,livemode,paid_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
  ON CONFLICT(provider,provider_invoice_id) DO UPDATE SET status=EXCLUDED.status,amount_due=EXCLUDED.amount_due,amount_paid=EXCLUDED.amount_paid,amount_refunded=EXCLUDED.amount_refunded,number=COALESCE(EXCLUDED.number,invoices.number),
   hosted_url=COALESCE(EXCLUDED.hosted_url,invoices.hosted_url),pdf_url=COALESCE(EXCLUDED.pdf_url,invoices.pdf_url),paid_at=COALESCE(EXCLUDED.paid_at,invoices.paid_at),
   subscription_id=COALESCE(invoices.subscription_id,EXCLUDED.subscription_id),user_id=COALESCE(invoices.user_id,EXCLUDED.user_id)`,
  [sub?.id||null,userId,sub?.provider||'stripe',inv.id,inv.number||null,inv.status,inv.amountDue,inv.amountPaid,inv.amountRefunded||0,inv.currency.toLowerCase(),iso(inv.periodStart),iso(inv.periodEnd),inv.hostedUrl||null,inv.pdfUrl||null,inv.description||null,!!inv.livemode,iso(inv.paidAt)]);
 if(sub&&inv.status==='paid'&&inv.amountPaid>0&&!(prev&&prev.status==='paid')){
  await mailSub(sub,'payment_receipt',{amount:formatMoney(inv.amountPaid,inv.currency),invoiceUrl:inv.hostedUrl||`${origin()}/billing`,periodEnd:fmtDate(inv.periodEnd||sub.current_period_end)},`inv:${inv.id}`);
 }
 if(sub&&(inv.amountRefunded||0)>Number(prev?.amount_refunded||0)){
  await mailSub(sub,'refund_issued',{amount:formatMoney((inv.amountRefunded||0)-Number(prev?.amount_refunded||0),inv.currency),invoiceUrl:inv.hostedUrl||`${origin()}/billing`},`ref:${inv.id}:${inv.amountRefunded}`);
 }
}

/** Asks the provider for the current state of one subscription and applies it. */
export async function syncSubscription(ref:{providerSubscriptionId?:string;id?:string},meta:Meta):Promise<SubRow|null>{
 const row=ref.id?(await pool.query('SELECT id,provider_subscription_id,provider FROM subscriptions WHERE id=$1',[ref.id])).rows[0]
  :(await pool.query('SELECT id,provider_subscription_id,provider FROM subscriptions WHERE provider_subscription_id=$1',[ref.providerSubscriptionId])).rows[0];
 // Subscriptions Fledge does not know belong to something else on the same provider account.
 if(!row||!row.provider_subscription_id||row.provider==='manual')return row?loadSub(row.id):null;
 const r=await provider.reconcile({subscriptionId:row.provider_subscription_id});
 const sub=await loadSub(row.id);
 if(!r.subscription||!sub)return sub;
 const res=await applySubscription(sub,r.subscription,meta);
 const fresh=res?.sub||sub;
 if(r.invoice)await applyInvoice(r.invoice,fresh);
 return fresh;
}

// --- Orders -------------------------------------------------------------------------------------------------------------------
/** Called when the provider says a checkout finished (or when the customer comes back to the shop). Safe to call repeatedly. */
export async function completeOrder(orderId:string,meta:Meta):Promise<{status:string;subscriptionId:string|null}>{
 const o=(await pool.query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];
 if(!o)return {status:'missing',subscriptionId:null};
 if(o.status==='paid'&&o.subscription_id)return {status:'paid',subscriptionId:o.subscription_id};
 if(!o.provider_session_id||o.provider==='manual')return {status:o.status,subscriptionId:o.subscription_id};
 const r=await provider.reconcile({sessionId:o.provider_session_id});
 const sess=r.session;
 if(!sess)return {status:o.status,subscriptionId:o.subscription_id};
 // The session must be the one created for this order (the core wrote the order id into it).
 if(sess.orderId&&sess.orderId!==o.id){await audit(null,'billing.order.mismatch','order',o.id,{session:sess.id});return {status:o.status,subscriptionId:null};}
 if(sess.status==='expired'){
  await pool.query("UPDATE orders SET status='expired' WHERE id=$1 AND status IN ('created','pending')",[o.id]);
  return {status:'expired',subscriptionId:null};
 }
 if(sess.status!=='complete'||!sess.subscriptionId)return {status:o.status,subscriptionId:null};
 const snap=o.snapshot||{};
 const c=await pool.connect();
 let subId:string;
 try{
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['order:'+o.id]);
  const existing=(await c.query('SELECT id FROM subscriptions WHERE provider=$1 AND provider_subscription_id=$2',[o.provider,sess.subscriptionId])).rows[0];
  if(existing)subId=existing.id;
  else{
   const ins=await c.query(`INSERT INTO subscriptions(user_id,plan_id,price_id,order_id,provider,provider_subscription_id,provider_customer_id,livemode,status,cycle,amount,currency,fulfilment,server_details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'incomplete',$9,$10,$11,$12,$13) RETURNING id`,
    [o.user_id,o.plan_id,o.price_id,o.id,o.provider,sess.subscriptionId,sess.customerId||o.provider_customer_id,typeof sess.livemode==='boolean'?sess.livemode:o.livemode,snap.cycle,snap.amount,snap.currency,snap.kind==='server'?'pending':'none',JSON.stringify(o.details||{})]);
   subId=ins.rows[0].id;
  }
  await c.query("UPDATE orders SET status='paid',paid_at=COALESCE(paid_at,now()),subscription_id=$2 WHERE id=$1",[o.id,subId]);
  if(sess.customerId)await c.query('INSERT INTO billing_customers(user_id,provider,livemode,provider_customer_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,provider,livemode) DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id',[o.user_id,o.provider,typeof sess.livemode==='boolean'?sess.livemode:o.livemode,sess.customerId]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 await audit(null,'billing.order.paid','order',o.id,{subscriptionId:subId});
 await syncSubscription({id:subId},meta);
 return {status:'paid',subscriptionId:subId};
}

// --- Manual (complimentary) subscriptions -----------------------------------------------------------------
export async function grantManual(o:{userId:string;planId:string;cycle?:Interval;endsAt?:Date|null;note?:string;serverName?:string;location?:string|null;variables?:Record<string,string>;actorId:string|null}){
 const plan=(await pool.query('SELECT * FROM plans WHERE id=$1',[o.planId])).rows[0];
 if(!plan)fail(404,'Plan not found');
 const user=(await pool.query("SELECT id FROM users WHERE id=$1 AND role='customer' AND NOT disabled AND status='active'",[o.userId])).rows[0];
 if(!user)fail(404,'Active customer not found');
 const price=(await pool.query('SELECT * FROM plan_prices WHERE plan_id=$1 AND active ORDER BY amount LIMIT 1',[o.planId])).rows[0];
 const cycle=o.cycle||price?.cycle||'month';
 const ins=await pool.query(`INSERT INTO subscriptions(user_id,plan_id,price_id,provider,status,cycle,amount,currency,fulfilment,server_details,manual_ends_at,current_period_end,note)
  VALUES($1,$2,$3,'manual','incomplete',$4,0,$5,$6,$7,$8,$8,$9) RETURNING id`,
  [o.userId,o.planId,price?.id||null,cycle,price?.currency||(await settings()).billing.currency,plan.kind==='server'?'pending':'none',JSON.stringify({name:o.serverName||plan.name,location:o.location||null,variables:o.variables||{}}),o.endsAt||null,o.note?String(o.note).slice(0,300):null]);
 const id=ins.rows[0].id;
 await moveTo(id,'active',{reason:'manual grant',source:'admin'});
 await audit(o.actorId,'billing.grant','subscription',id,{planId:o.planId,userId:o.userId,endsAt:o.endsAt||null});
 return id as string;
}

// --- Customer and administrator actions ------------------------------------------------------------------------------
export async function cancelSubscription(subId:string,when:'period_end'|'now',meta:Meta){
 const sub=await loadSub(subId);
 if(!sub)fail(404,'Subscription not found');
 if(['canceled','terminated'].includes(sub.status))fail(409,'This subscription has already ended');
 if(when==='period_end'&&sub.cancel_at_period_end)fail(409,'This subscription is already set to end');
 if(sub.provider==='manual'||!sub.provider_subscription_id){
  if(when==='now'||!sub.current_period_end)await moveTo(subId,'canceled',meta,{});
  else await moveTo(subId,sub.status,meta,{cancel_at_period_end:true});
 }else{
  await provider.cancel(sub.provider_subscription_id,when);
  await syncSubscription({id:subId},meta);
 }
 const after=await loadSub(subId);
 if(after?.status==='active'||after?.status==='trialing'||after?.status==='past_due'){
  await mailSub(after,'subscription_canceled',{endDate:fmtDate(after.current_period_end),retentionDate:''},`cancel:${fmtDate(after.current_period_end)}`);
 }
 await audit(meta.actor||null,'billing.cancel','subscription',subId,{when,source:meta.source});
 return after;
}
export async function resumeSubscription(subId:string,meta:Meta){
 const sub=await loadSub(subId);
 if(!sub)fail(404,'Subscription not found');
 if(!sub.cancel_at_period_end)fail(409,'This subscription is not set to end');
 if(['canceled','terminated'].includes(sub.status))fail(409,'This subscription has already ended; subscribe again instead');
 if(sub.provider==='manual'||!sub.provider_subscription_id)await moveTo(subId,sub.status,meta,{cancel_at_period_end:false});
 else{await provider.resume(sub.provider_subscription_id);await syncSubscription({id:subId},meta);}
 const after=await loadSub(subId);
 if(after)await mailSub(after,'subscription_resumed',{},`resume:${after.version}`);
 return after;
}

/** Re-queues a failed fulfilment right now. */
export async function retryFulfilment(subId:string){
 await patch(subId,{fulfilment:'pending',next_fulfilment_at:null});
 await fulfil(subId);
 return loadSub(subId);
}

// --- Disputes ------------------------------------------------------------------------------------------------------------------
export async function handleDispute(ev:WebhookEvent,sub:SubRow|null){
 if(!sub)return;
 const cfg=(await settings()).billing;
 const holds=holdsOf(sub).filter(h=>h.id!==ev.refs.disputeId);
 if(ev.kind==='dispute_opened'){
  holds.push({type:'dispute',id:ev.refs.disputeId,at:new Date().toISOString()});
  await patch(sub.id,{holds});
  if(cfg.suspendOnDispute)await holdServer(sub.id);
  await adminNotify('billing.dispute',`Payment dispute from ${sub.email}`,sub.plan_name,'admin_dispute',{customerEmail:sub.email,planName:sub.plan_name,link:`${origin()}/billing`},`dp:${ev.refs.disputeId||sub.id}`);
  return;
 }
 await patch(sub.id,{holds});
 const fresh=await loadSub(sub.id);
 if(ev.won===false){
  // Lost: the money is gone, so the subscription ends.
  await cancelSubscription(sub.id,'now',{reason:'dispute lost',source:'system'}).catch(()=>{});
 }else if(fresh&&(fresh.status==='active'||fresh.status==='trialing')){
  await releaseServer(fresh);
 }
}

// --- Scheduled work ----------------------------------------------------------------------------------------------------------------
const stepGuard=async(name:string,fn:()=>Promise<void>)=>{try{await fn();}catch(e){console.error(`Billing step ${name} failed:`,(e as Error)?.message);}};

export async function sweepBilling(){
 const cfg=(await settings()).billing;
 const now=new Date();
 // 1. Payments that are late: reminders, suspension, termination.
 await stepGuard('dunning',async()=>{
  const rows=(await pool.query("SELECT id FROM subscriptions WHERE status IN ('past_due','suspended') AND past_due_since IS NOT NULL LIMIT 200")).rows;
  for(const r of rows){
   const sub=await loadSub(r.id);
   if(!sub)continue;
   const done=(sub.dunning||{}) as Dunning;
   const actions=dunningActions(sub.status,sub.past_due_since?new Date(sub.past_due_since):null,now,cfg,done);
   if(!actions.length)continue;
   const sent={...(done.sent||{})};
   for(const a of actions){
    const mark=a.kind==='suspend'?'suspend':a.kind==='terminate'?'terminate':`r${a.day}`;
    sent[mark]=now.toISOString();
    await patch(sub.id,{dunning:{sent}});
    const since=new Date(sub.past_due_since);
    const suspendDate=fmtDate(new Date(since.getTime()+cfg.suspendAfterDays*86400000));
    const terminateDate=cfg.autoTerminate?fmtDate(new Date(since.getTime()+cfg.terminateAfterDays*86400000)):'';
    if(a.kind==='reminder')await mailSub(sub,'payment_reminder',{suspendDate},`d${a.day}`);
    else if(a.kind==='final')await mailSub(sub,'payment_final',{terminateDate},`d${a.day}`);
    else if(a.kind==='suspend')await moveTo(sub.id,'suspended',{reason:`unpaid for ${a.day} days`,source:'scheduler'});
    else if(a.kind==='terminate')await moveTo(sub.id,'terminated',{reason:`unpaid for ${a.day} days`,source:'scheduler'}).then(()=>{});
   }
  }
 });
 // 2. Cancelled subscriptions whose data-retention time is over.
 await stepGuard('retention',async()=>{
  const rows=(await pool.query("SELECT id FROM subscriptions WHERE status='canceled' AND retention_until IS NOT NULL AND retention_until<=now() LIMIT 100")).rows;
  if(!rows.length)return;
  if(cfg.autoTerminate){for(const r of rows)await moveTo(r.id,'terminated',{reason:'retention period over',source:'scheduler'});return;}
  await emit({kind:'billing.health',severity:'warn',title:`${rows.length} cancelled server(s) are past their retention time`,body:'Open Billing, Subscriptions to remove them, or turn on automatic termination in Settings, Billing.',dedupe:{key:'retention-over',minutes:60*24}});
 });
 // 3. Trials about to end, and renewals about to happen.
 await stepGuard('reminders',async()=>{
  if(cfg.trialEndingDays>0){
   const rows=(await pool.query("SELECT id FROM subscriptions WHERE status='trialing' AND trial_end IS NOT NULL AND trial_end<=now()+make_interval(days=>$1) AND trial_end>now() LIMIT 200",[cfg.trialEndingDays])).rows;
   for(const r of rows){const s=await loadSub(r.id);if(s)await mailSub(s,'trial_ending',{date:fmtDate(s.trial_end)},`trial:${fmtDate(s.trial_end)}`);}
  }
  if(cfg.renewalReminderDays>0){
   const rows=(await pool.query("SELECT id FROM subscriptions WHERE status='active' AND provider<>'manual' AND NOT cancel_at_period_end AND current_period_end IS NOT NULL AND current_period_end<=now()+make_interval(days=>$1) AND current_period_end>now() AND amount>0 LIMIT 200",[cfg.renewalReminderDays])).rows;
   for(const r of rows){const s=await loadSub(r.id);if(s)await mailSub(s,'renewal_upcoming',{date:fmtDate(s.current_period_end)},`ren:${fmtDate(s.current_period_end)}`);}
  }
 });
 // 4. Complimentary subscriptions that reached their end date.
 await stepGuard('manual',async()=>{
  const rows=(await pool.query("SELECT id FROM subscriptions WHERE provider='manual' AND status IN ('active','trialing','past_due') AND manual_ends_at IS NOT NULL AND manual_ends_at<=now() LIMIT 100")).rows;
  for(const r of rows)await moveTo(r.id,'canceled',{reason:'end date reached',source:'scheduler'});
  const flagged=(await pool.query("SELECT id FROM subscriptions WHERE provider='manual' AND status='active' AND cancel_at_period_end AND current_period_end IS NOT NULL AND current_period_end<=now() LIMIT 100")).rows;
  for(const r of flagged)await moveTo(r.id,'canceled',{reason:'cancelled at the end of the period',source:'scheduler'});
 });
 // 5. Paid but no server yet: try again.
 await stepGuard('fulfilment',async()=>{
  const rows=(await pool.query("SELECT id,created_at FROM subscriptions WHERE fulfilment IN ('pending','failed') AND status IN ('active','trialing','past_due') AND (next_fulfilment_at IS NULL OR next_fulfilment_at<=now()) LIMIT 25")).rows;
  for(const r of rows){
   const within=Date.now()-new Date(r.created_at).getTime()<cfg.provisionRetryHours*3600000;
   if(within)await fulfil(r.id);
   else if(cfg.failedFulfilment==='refund')await refundAndCancel(r.id).catch(e=>console.error('Automatic refund failed:',(e as Error)?.message));
  }
 });
 // 6. Checkout attempts nobody finished.
 await stepGuard('orders',async()=>{
  await pool.query("UPDATE orders SET status='expired' WHERE status IN ('created','pending') AND expires_at<now()");
 });
}

/** When a paid server can never be created: give the money back and end the subscription. */
export async function refundAndCancel(subId:string){
 const sub=await loadSub(subId);
 if(!sub)return;
 if(sub.provider!=='manual'){
  const inv=(await pool.query("SELECT provider_invoice_id FROM invoices WHERE subscription_id=$1 AND status='paid' AND amount_paid>amount_refunded ORDER BY created_at DESC LIMIT 1",[subId])).rows[0];
  if(inv)await provider.refund(inv.provider_invoice_id);
 }
 await cancelSubscription(subId,'now',{reason:'refunded because the server could not be created',source:'system'});
 await audit(null,'billing.refund_cancel','subscription',subId);
}

/** Compares subscriptions with the provider and repairs anything a missed webhook left behind. */
export async function reconcileSweep(){
 const cfg=(await settings()).billing;
 if(!(await activeProvider()))return;
 const rows=(await pool.query(`SELECT id,status FROM subscriptions WHERE provider<>'manual' AND provider_subscription_id IS NOT NULL AND status NOT IN ('terminated')
  AND (reconciled_at IS NULL OR reconciled_at<now()-make_interval(mins=>$1)) AND (status<>'canceled' OR reconciled_at IS NULL) ORDER BY reconciled_at NULLS FIRST LIMIT 20`,[cfg.reconcileMinutes])).rows;
 for(const r of rows){
  try{
   const res=await syncSubscription({id:r.id},{reason:'scheduled check',source:'reconcile'});
   if(res&&res.status!==r.status)await audit(null,'billing.drift','subscription',r.id,{from:r.status,to:res.status});
  }catch(e){console.error('Reconcile failed:',(e as Error)?.message);}
 }
}

void notifyUser;void addMonths;void fail;
