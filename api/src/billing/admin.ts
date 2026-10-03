import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,txt,asId,audit,page} from '../core.js';
import {settings} from '../settings.js';
import {formatMoney,perMonth,INTERVALS,isInterval,type Interval} from '../money.js';
import {activeProvider,provider} from './provider.js';
import {loadSub,serverOf,cancelSubscription,resumeSubscription,grantManual,moveTo,patch,syncSubscription,retryFulfilment,terminateServer,holdServer,releaseServer,refundAndCancel,applyInvoice} from './engine.js';
import {changePlan} from './change.js';
import {inboxHealth,processInbox} from './webhooks.js';
import {readiness,providerState,clearProviderState} from './store.js';
import {canMove,type Status} from './states.js';

// The administrator's side of billing: subscriptions, invoices, the numbers, and health.

const subShape=(s:any)=>({id:s.id,userId:s.user_id,email:s.email,planId:s.plan_id,planName:s.plan_name,kind:s.plan_kind,status:s.status,providerStatus:s.provider_status,provider:s.provider,providerSubscriptionId:s.provider_subscription_id,
 cycle:s.cycle,amount:Number(s.amount),currency:s.currency,amountText:formatMoney(s.amount,s.currency),currentPeriodStart:s.current_period_start,currentPeriodEnd:s.current_period_end,trialEnd:s.trial_end,cancelAtPeriodEnd:s.cancel_at_period_end,
 pastDueSince:s.past_due_since,suspendedAt:s.suspended_at,canceledAt:s.canceled_at,endedAt:s.ended_at,retentionUntil:s.retention_until,manualEndsAt:s.manual_ends_at,note:s.note,
 fulfilment:s.fulfilment,fulfilmentAttempts:s.fulfilment_attempts,fulfilmentError:s.fulfilment_error,holds:s.holds||[],livemode:s.livemode,createdAt:s.created_at,reconciledAt:s.reconciled_at,
 server:s.server_id?{id:s.server_id,name:s.server_name,status:s.server_status,suspendedReason:s.suspended_reason}:null});

const LIST=`SELECT s.*,p.name AS plan_name,p.kind AS plan_kind,u.email,sv.id AS server_id,sv.name AS server_name,sv.observed_status AS server_status,sv.suspended_reason
 FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN users u ON u.id=s.user_id LEFT JOIN servers sv ON sv.subscription_id=s.id AND sv.deleted_at IS NULL`;

export function billingAdminRoutes(app:FastifyInstance){
 app.get('/api/billing/admin/subscriptions',async(req)=>{
  admin(req);
  const q=req.query as any,p=page(q);
  const status=typeof q.status==='string'&&q.status?q.status:null,search=typeof q.q==='string'&&q.q.trim()?`%${q.q.trim().toLowerCase().replace(/[%_]/g,'')}%`:null,plan=typeof q.plan==='string'&&q.plan?asId(q.plan):null,user=typeof q.user==='string'&&q.user?asId(q.user):null;
  const rows=(await pool.query(`${LIST} WHERE ($1::text IS NULL OR s.status=$1) AND ($2::text IS NULL OR lower(u.email) LIKE $2) AND ($3::uuid IS NULL OR s.plan_id=$3) AND ($4::uuid IS NULL OR s.user_id=$4) ORDER BY s.created_at DESC LIMIT $5 OFFSET $6`,[status,search,plan,user,p.limit,p.offset])).rows;
  const counts=Object.fromEntries((await pool.query('SELECT status,count(*)::int n FROM subscriptions GROUP BY status')).rows.map((r:any)=>[r.status,r.n]));
  return {items:rows.map(subShape),counts};
 });
 app.get('/api/billing/admin/subscriptions/:id',async(req)=>{
  admin(req);
  const id=asId((req.params as any).id);
  const row=(await pool.query(`${LIST} WHERE s.id=$1`,[id])).rows[0];
  if(!row)fail(404,'Subscription not found');
  const events=(await pool.query('SELECT at,from_status AS "from",to_status AS "to",reason,source,ref FROM subscription_events WHERE subscription_id=$1 ORDER BY id DESC LIMIT 100',[id])).rows;
  const invoices=(await pool.query('SELECT id,number,status,amount_due,amount_paid,amount_refunded,currency,created_at,paid_at,hosted_url,provider_invoice_id FROM invoices WHERE subscription_id=$1 ORDER BY created_at DESC LIMIT 50',[id])).rows
   .map((i:any)=>({id:i.id,number:i.number,status:i.status,amountText:formatMoney(i.amount_due,i.currency),paidText:formatMoney(i.amount_paid,i.currency),refundedText:Number(i.amount_refunded)?formatMoney(i.amount_refunded,i.currency):null,refundable:Number(i.amount_paid)>Number(i.amount_refunded),createdAt:i.created_at,paidAt:i.paid_at,url:i.hosted_url}));
  const order=row.order_id?(await pool.query('SELECT id,status,created_at,paid_at,snapshot,terms_version FROM orders WHERE id=$1',[row.order_id])).rows[0]:null;
  return {...subShape(row),events,invoices,order};
 });
 const act=(path:string,fn:(req:any,sub:any)=>Promise<unknown>)=>app.post(`/api/billing/admin/subscriptions/:id/${path}`,async(req)=>{
  admin(req);
  const sub=await loadSub(asId((req.params as any).id));
  if(!sub)fail(404,'Subscription not found');
  const r=await fn(req,sub);
  return r===undefined?{ok:true}:r;
 });
 act('cancel',async(req,s)=>{
  const when=(req.body as any)?.when==='now'?'now':'period_end';
  await cancelSubscription(s.id,when,{reason:'cancelled by an administrator',source:'admin',actor:req.actor.id});
 });
 act('resume',async(req,s)=>{await resumeSubscription(s.id,{reason:'resumed by an administrator',source:'admin',actor:req.actor.id});});
 act('retry-fulfilment',async(req,s)=>{await retryFulfilment(s.id);await audit(req.actor.id,'billing.retry_fulfilment','subscription',s.id);});
 act('sync',async(req,s)=>{
  if(s.provider==='manual')fail(409,'Complimentary subscriptions are not on the provider.');
  await syncSubscription({id:s.id},{reason:'checked by an administrator',source:'admin'});await audit(req.actor.id,'billing.sync','subscription',s.id);
 });
 act('terminate',async(req,s)=>{
  if((req.body as any)?.confirm!==true)fail(400,'This deletes the server and its data. Send {confirm:true}.');
  if(!['suspended','canceled'].includes(s.status)&&(req.body as any)?.force!==true)fail(409,'Only ended or suspended subscriptions can be terminated.');
  if(s.status==='terminated')fail(409,'Already terminated');
  if(!canMove(s.status as Status,'terminated')){
   // Active subscriptions are ended first.
   await cancelSubscription(s.id,'now',{reason:'terminated by an administrator',source:'admin',actor:req.actor.id});
  }
  await moveTo(s.id,'terminated',{reason:'terminated by an administrator',source:'admin'});
  await audit(req.actor.id,'billing.terminate_request','subscription',s.id);
 });
 // A hold keeps the server stopped no matter what the customer pays (for abuse, disputes, investigations).
 act('hold',async(req,s)=>{
  const on=(req.body as any)?.on!==false;
  const holds=(s.holds||[]).filter((h:any)=>h.type!=='admin');
  if(on)holds.push({type:'admin',at:new Date().toISOString(),by:req.actor.id,note:String((req.body as any)?.note||'').slice(0,200)});
  await patch(s.id,{holds});
  if(on)await holdServer(s.id);
  else{const fresh=await loadSub(s.id);if(fresh&&['active','trialing'].includes(fresh.status))await releaseServer(fresh);}
  await audit(req.actor.id,on?'billing.hold':'billing.unhold','subscription',s.id);
 });
 act('extend',async(req,s)=>{
  if(s.provider!=='manual')fail(409,'Only complimentary subscriptions have an end date you can set.');
  const at=(req.body as any)?.endsAt===null?null:new Date(String((req.body as any)?.endsAt||''));
  if(at&&Number.isNaN(at.getTime()))fail(400,'Enter a valid date');
  await moveTo(s.id,s.status==='canceled'?'active':s.status,{reason:'end date changed',source:'admin'},{manual_ends_at:at,current_period_end:at,cancel_at_period_end:false});
  await audit(req.actor.id,'billing.extend','subscription',s.id,{endsAt:at});
 });
 act('note',async(req,s)=>{await patch(s.id,{note:String((req.body as any)?.note??'').slice(0,300)});});
 act('change',async(req,s)=>{
  const b=req.body as any;
  if(!isInterval(b?.cycle))fail(400,'cycle is required');
  await changePlan(s.id,asId(b?.planId),b.cycle,{source:'admin',actor:req.actor.id});
 });
 act('refund',async(req,s)=>{
  const b=req.body as any,inv=(await pool.query('SELECT * FROM invoices WHERE id=$1 AND subscription_id=$2',[asId(b?.invoiceId),s.id])).rows[0];
  if(!inv)fail(404,'Invoice not found');
  if(s.provider==='manual')fail(409,'There is nothing to refund on a complimentary subscription.');
  const amount=b?.amount===undefined||b?.amount===null?undefined:Number(b.amount);
  if(amount!==undefined&&(!Number.isSafeInteger(amount)||amount<1||amount>Number(inv.amount_paid)-Number(inv.amount_refunded)))fail(400,'That is more than can still be refunded.');
  const r=await provider.refund(inv.provider_invoice_id,amount);
  const fresh=await provider.reconcile({invoiceId:inv.provider_invoice_id});
  if(fresh.invoice)await applyInvoice(fresh.invoice,s);
  await audit(req.actor.id,'billing.refund','subscription',s.id,{invoice:inv.id,amount:amount??null,refund:r.refundId||null});
  if(b?.cancel===true)await cancelSubscription(s.id,'now',{reason:'refunded and cancelled',source:'admin',actor:req.actor.id}).catch(()=>{});
 });
 act('refund-cancel',async(req,s)=>{await refundAndCancel(s.id);await audit(req.actor.id,'billing.refund_cancel','subscription',s.id);});

 app.post('/api/billing/grants',async(req)=>{
  admin(req);
  const b=req.body as any;
  if(!(await settings()).billing.allowManualGrants)fail(403,'Manual grants are turned off in Settings, Billing.');
  const endsAt=b?.endsAt?new Date(String(b.endsAt)):null;
  if(endsAt&&Number.isNaN(endsAt.getTime()))fail(400,'Enter a valid end date');
  if(endsAt&&endsAt.getTime()<Date.now())fail(400,'The end date is in the past');
  const id=await grantManual({userId:asId(b?.userId),planId:asId(b?.planId),cycle:isInterval(b?.cycle)?b.cycle:undefined,endsAt,note:b?.note,serverName:b?.serverName?txt(b.serverName,80):undefined,location:b?.location?txt(b.location,80):null,actorId:req.actor!.id});
  const row=(await pool.query(`${LIST} WHERE s.id=$1`,[id])).rows[0];
  return subShape(row);
 });

 // ---- Numbers ----
 app.get('/api/billing/overview',async(req)=>{
  admin(req);
  const live=(await pool.query("SELECT s.cycle,s.amount,s.currency,s.status,s.provider FROM subscriptions s WHERE s.status IN ('active','trialing','past_due') AND s.provider<>'manual'")).rows;
  const mrr:Record<string,number>={};
  for(const r of live)if(r.status!=='trialing')mrr[r.currency]=(mrr[r.currency]||0)+perMonth(Number(r.amount),r.cycle as Interval);
  const byStatus=Object.fromEntries((await pool.query('SELECT status,count(*)::int n FROM subscriptions GROUP BY status')).rows.map((r:any)=>[r.status,r.n]));
  const month=(await pool.query("SELECT currency,sum(amount_paid-amount_refunded)::bigint total,count(*)::int n FROM invoices WHERE status='paid' AND paid_at>=date_trunc('month',now()) GROUP BY currency")).rows;
  const last=(await pool.query("SELECT currency,sum(amount_paid-amount_refunded)::bigint total FROM invoices WHERE status='paid' AND paid_at>=date_trunc('month',now())-interval '1 month' AND paid_at<date_trunc('month',now()) GROUP BY currency")).rows;
  const churn=(await pool.query("SELECT count(*)::int n FROM subscriptions WHERE canceled_at>=date_trunc('month',now()) AND provider<>'manual'")).rows[0].n;
  const startActive=(await pool.query("SELECT count(*)::int n FROM subscriptions WHERE created_at<date_trunc('month',now()) AND (ended_at IS NULL OR ended_at>=date_trunc('month',now())) AND provider<>'manual'")).rows[0].n;
  const newMonth=(await pool.query("SELECT count(*)::int n FROM subscriptions WHERE created_at>=date_trunc('month',now()) AND provider<>'manual'")).rows[0].n;
  const failed=(await pool.query("SELECT count(*)::int n FROM subscriptions WHERE status='past_due'")).rows[0].n;
  const byPlan=(await pool.query("SELECT p.id,p.name,count(*) FILTER (WHERE s.status IN ('active','trialing','past_due'))::int active FROM plans p LEFT JOIN subscriptions s ON s.plan_id=p.id GROUP BY p.id ORDER BY active DESC LIMIT 10")).rows;
  return {mrr:Object.entries(mrr).map(([currency,amount])=>({currency,amount,text:formatMoney(amount,currency)})),
   revenueThisMonth:month.map((r:any)=>({currency:r.currency,amount:Number(r.total),text:formatMoney(r.total,r.currency),invoices:r.n})),
   revenueLastMonth:last.map((r:any)=>({currency:r.currency,amount:Number(r.total),text:formatMoney(r.total,r.currency)})),
   subscriptions:byStatus,trials:byStatus.trialing||0,pastDue:failed,newThisMonth:newMonth,canceledThisMonth:churn,churnRate:startActive?Math.round(churn*1000/startActive)/10:0,byPlan};
 });
 app.get('/api/billing/invoices',async(req)=>{
  admin(req);
  const q=req.query as any,p=page(q);
  const rows=(await pool.query(`SELECT i.*,u.email,pl.name AS plan FROM invoices i LEFT JOIN users u ON u.id=i.user_id LEFT JOIN subscriptions s ON s.id=i.subscription_id LEFT JOIN plans pl ON pl.id=s.plan_id
   WHERE ($1::text IS NULL OR i.status=$1) ORDER BY i.created_at DESC LIMIT $2 OFFSET $3`,[typeof q.status==='string'&&q.status?q.status:null,p.limit,p.offset])).rows;
  return rows.map((i:any)=>({id:i.id,number:i.number,status:i.status,email:i.email,plan:i.plan,amountText:formatMoney(i.amount_due,i.currency),paidText:formatMoney(i.amount_paid,i.currency),refundedText:Number(i.amount_refunded)?formatMoney(i.amount_refunded,i.currency):null,createdAt:i.created_at,paidAt:i.paid_at,url:i.hosted_url,livemode:i.livemode,subscriptionId:i.subscription_id}));
 });
 app.get('/api/billing/invoices.csv',async(req,reply)=>{
  admin(req);
  const rows=(await pool.query(`SELECT i.number,i.status,u.email,pl.name AS plan,i.amount_due,i.amount_paid,i.amount_refunded,i.currency,i.created_at,i.paid_at FROM invoices i LEFT JOIN users u ON u.id=i.user_id LEFT JOIN subscriptions s ON s.id=i.subscription_id LEFT JOIN plans pl ON pl.id=s.plan_id ORDER BY i.created_at DESC LIMIT 20000`)).rows;
  const cell=(v:any)=>{const t=v===null||v===undefined?'':v instanceof Date?v.toISOString():String(v);return /^[=+\-@\t\r]/.test(t)?`'${t}`:t;};
  const q=(v:any)=>`"${cell(v).replace(/"/g,'""')}"`;
  const csv=['number,status,customer,plan,due,paid,refunded,currency,created,paid_at',...rows.map((r:any)=>[r.number,r.status,r.email,r.plan,r.amount_due,r.amount_paid,r.amount_refunded,r.currency,r.created_at,r.paid_at].map(q).join(','))].join('\n');
  reply.header('content-type','text/csv; charset=utf-8').header('content-disposition','attachment; filename="invoices.csv"');
  return csv;
 });

 // ---- Health ----
 app.get('/api/billing/readiness',async(req)=>{admin(req);const checks=await readiness();return {ready:checks.filter(c=>c.blocking).every(c=>c.ok),checks};});
 app.get('/api/billing/health',async(req)=>{
  admin(req);
  const p=await activeProvider();
  const state=p?await providerState(true):null;
  const failedFulfilments=(await pool.query("SELECT count(*)::int n FROM subscriptions WHERE fulfilment='failed' AND status IN ('active','trialing','past_due')")).rows[0].n;
  const drift=(await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='billing.drift' AND created_at>now()-interval '24 hours'")).rows[0].n;
  const overdue=(await pool.query("SELECT count(*)::int n FROM subscriptions WHERE status='canceled' AND retention_until<=now()")).rows[0].n;
  const inbox=await inboxHealth();
  const problems:string[]=[];
  if(p&&!state?.ok)problems.push(state?.message||'The payment provider is not answering.');
  if(inbox.stuck)problems.push(`${inbox.stuck} payment event(s) could not be processed.`);
  if(failedFulfilments)problems.push(`${failedFulfilments} paid server(s) could not be created.`);
  if(overdue)problems.push(`${overdue} cancelled server(s) are past their retention time.`);
  return {provider:p?{id:p.id,name:p.name,pluginId:p.pluginId}:null,providerOk:!!state?.ok,livemode:state?.livemode??null,message:state?.message||'',webhookUrl:p?`${(process.env.WEB_ORIGIN||'').replace(/\/$/,'')}/api/billing/webhooks/${p.id}`:null,inbox,failedFulfilments,driftLast24h:drift,expiredWaiting:overdue,problems};
 });
 app.get('/api/billing/events',async(req)=>{
  admin(req);
  const p=page(req.query);
  return (await pool.query('SELECT id,provider,event_id AS "eventId",type,livemode,received_at AS "receivedAt",processed_at AS "processedAt",attempts,error,refs FROM billing_events ORDER BY id DESC LIMIT $1 OFFSET $2',[p.limit,p.offset])).rows;
 });
 app.post('/api/billing/events/:id/retry',async(req)=>{
  admin(req);
  const r=await pool.query('UPDATE billing_events SET processed_at=NULL,attempts=0,error=NULL,next_attempt_at=now() WHERE id=$1 RETURNING id',[Number((req.params as any).id)||0]);
  if(!r.rowCount)fail(404,'Event not found');
  void processInbox(5).catch(()=>{});
  return {ok:true};
 });
 app.post('/api/billing/provider/check',async(req)=>{admin(req);clearProviderState();const s=await providerState(true);return s;});
 // Test-mode records must not sit next to live ones; this clears them once the provider is in live mode.
 app.post('/api/billing/test-data/reset',async(req)=>{
  admin(req);
  if((req.body as any)?.confirm!=='delete test data')fail(400,'Type “delete test data” to confirm.');
  const state=await providerState(true);
  if(state.livemode!==true)fail(409,'This only works while the provider is in live mode, so real records can never be removed by mistake.');
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const subs=(await c.query("SELECT id FROM subscriptions WHERE livemode=false AND provider<>'manual'")).rows.map((r:any)=>r.id);
   const blocked=(await c.query('SELECT count(*)::int n FROM servers WHERE subscription_id=ANY($1::uuid[]) AND deleted_at IS NULL',[subs])).rows[0].n;
   if(blocked){await c.query('ROLLBACK');fail(409,`${blocked} test server(s) still exist. Delete those servers first.`);}
   await c.query('DELETE FROM invoices WHERE livemode=false');
   await c.query('DELETE FROM billing_events WHERE livemode=false');
   await c.query('UPDATE servers SET subscription_id=NULL WHERE subscription_id=ANY($1::uuid[])',[subs]);
   await c.query('DELETE FROM subscription_events WHERE subscription_id=ANY($1::uuid[])',[subs]);
   await c.query('DELETE FROM subscriptions WHERE id=ANY($1::uuid[])',[subs]);
   await c.query('DELETE FROM orders WHERE livemode=false AND provider<>\'manual\'');
   await c.query('DELETE FROM billing_customers WHERE livemode=false');
   await c.query('COMMIT');
   await audit(req.actor!.id,'billing.test_data.reset','billing','-',{subscriptions:subs.length});
   return {ok:true,removed:subs.length};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 });
 void serverOf;void INTERVALS;
}
