import type {FastifyInstance} from 'fastify';
import {pool,fail,txt,asId,audit,WEB_ORIGIN,looksLikeEmail} from '../core.js';
import {settings} from '../settings.js';
import {mailerReady} from '../mailer.js';
import {bump} from '../signup.js';
import {isVerified,usableLocations} from '../selfservice.js';
import {effectiveDefs,checkValue} from '../templates.js';
import {formatMoney,isInterval,INTERVALS,type Interval} from '../money.js';
import {activeProvider,provider} from './provider.js';
import {catalog,availability} from './plans.js';
import {completeOrder,cancelSubscription,resumeSubscription,loadSub,grantManual,serverOf,fmtDate} from './engine.js';
import {changePlan} from './change.js';

// The customer side of billing: the store, checkout, order status, the billing page.

const origin=()=>WEB_ORIGIN.replace(/\/$/,'');

// Asking the provider on every page view would be slow; its mode and health change rarely.
let stateCache:{at:number;ok:boolean;livemode:boolean|null;message:string}|undefined;
export async function providerState(force=false){
 if(!force&&stateCache&&Date.now()-stateCache.at<60_000)return stateCache;
 const p=await activeProvider();
 if(!p)return stateCache={at:Date.now(),ok:false,livemode:null,message:'No payment provider is switched on.'};
 try{
  const h=await provider.health();
  return stateCache={at:Date.now(),ok:!!h.ok,livemode:typeof h.livemode==='boolean'?h.livemode:null,message:String(h.message||'').slice(0,300)};
 }catch(e:any){return stateCache={at:Date.now(),ok:false,livemode:null,message:String(e?.message||'The payment provider could not be reached').slice(0,300)};}
}
export const clearProviderState=()=>{stateCache=undefined;};

export type Check={id:string;label:string;ok:boolean;detail:string;blocking:boolean};
/** What has to be true before the store can take money. */
/** `store` lets the settings being saved be judged before they are stored. */
export async function readiness(store?:Record<string,any>):Promise<Check[]>{
 const all=await settings(),st=(store||all.store) as typeof all.store,bl=all.billing;
 const p=await activeProvider();
 const state=p?await providerState(true):null;
 const plans=Number((await pool.query("SELECT count(DISTINCT p.id) n FROM plans p JOIN plan_prices x ON x.plan_id=p.id AND x.active WHERE p.active AND p.archived_at IS NULL")).rows[0].n);
 const hook=Number((await pool.query('SELECT count(*) n FROM billing_events')).rows[0].n);
 const mixed=state?.livemode===null||state?.livemode===undefined?0:Number((await pool.query("SELECT count(*) n FROM subscriptions WHERE provider<>'manual' AND livemode<>$1 AND status NOT IN ('canceled','terminated')",[state.livemode])).rows[0].n);
 return [
  {id:'provider',label:'A payment provider is installed and switched on',ok:!!p,detail:p?`${p.name} (${p.plugin.name})`:'Install a payment plugin under Plugins, then choose it in Settings, Billing.',blocking:true},
  {id:'connection',label:'The provider answers and accepts the keys',ok:!!state?.ok,detail:state?.message||'Enter the keys in the plugin’s settings and run its health check.',blocking:true},
  {id:'mode',label:'No test and live records are mixed',ok:mixed===0,detail:mixed?`${mixed} subscription(s) were made in the other mode. Switch back, or remove the test data.`:state?.livemode===true?'Live mode':state?.livemode===false?'Test mode (no real money moves)':'Mode unknown',blocking:true},
  {id:'email',label:'Email works (receipts, reminders)',ok:await mailerReady(),detail:'Settings, Email',blocking:true},
  {id:'plans',label:'At least one active plan with a price',ok:plans>0,detail:plans?`${plans} active plan(s)`:'Create a plan under Billing, Plans.',blocking:true},
  {id:'terms',label:'Terms and privacy addresses are set',ok:!st.requireTerms||(!!st.termsUrl&&!!st.privacyUrl),detail:st.requireTerms?'Settings, Store':'Not required',blocking:true},
  {id:'company',label:'Your company name and support email are set',ok:!!st.companyName&&!!st.companyEmail,detail:'Shown on receipts and in the footer of billing emails. Settings, Store.',blocking:false},
  {id:'webhook',label:'A payment event has reached the panel',ok:hook>0,detail:hook?`${hook} event(s) received`:`Point your provider’s webhook at ${origin()}/api/billing/webhooks/${p?.id||'<provider>'} and send a test event.`,blocking:false},
  {id:'retention',label:'Expired servers are cleaned up',ok:bl.autoTerminate||true,detail:bl.autoTerminate?'Automatic termination is on':'Off: cancelled servers stay until you remove them (Settings, Billing).',blocking:false},
 ];
}
export async function canSell():Promise<{ok:boolean;reason?:string}>{
 const st=(await settings()).store;
 if(!st.enabled)return {ok:false,reason:'The store is closed.'};
 const p=await activeProvider();
 if(!p)return {ok:false,reason:'Payments are not available right now.'};
 const s=await providerState();
 if(!s.ok)return {ok:false,reason:'Payments are not available right now.'};
 return {ok:true};
}

const legal=(st:any)=>({termsUrl:st.termsUrl,privacyUrl:st.privacyUrl,withdrawalNotice:st.withdrawalNotice,taxNote:st.taxNote,requireTerms:st.requireTerms,companyName:st.companyName,companyEmail:st.companyEmail,supportUrl:st.supportUrl});

export async function storeAccessFor(userId:string){
 const u=(await pool.query("SELECT id,email,role,status,disabled,email_verified_at,signup_source FROM users WHERE id=$1",[userId])).rows[0];
 const st=(await settings()).store;
 if(!u||u.disabled||u.status!=='active')return {ok:false,reason:'This account cannot buy right now.'};
 if(st.requireVerifiedEmail&&!isVerified(u))return {ok:false,reason:'Confirm your email address before buying.'};
 return {ok:true,user:u};
}

export function storeRoutes(app:FastifyInstance){
 // Public catalogue, only when the administrator turned it on.
 app.get('/api/store/public',async()=>{
  const all=await settings(),st=all.store;
  if(!st.enabled||!st.publicCatalog)fail(404,'Not found');
  return {title:st.title,intro:st.intro,defaultInterval:st.defaultInterval,legal:legal(st),plans:await catalog(null),sell:(await canSell()).ok};
 });
 app.get('/api/store',async(req)=>{
  const all=await settings(),st=all.store;
  const isAdmin=req.actor!.role==='admin';
  const freeOnly=!st.enabled&&!isAdmin;
  if(freeOnly&&all.selfService.mode==='off')fail(404,'The store is closed');
  const sell=freeOnly?{ok:true}:await canSell();
  const access=isAdmin?{ok:false,reason:'Administrators preview the store; buy as a customer, or grant plans from Billing.'}:await storeAccessFor(req.actor!.id);
  const limits=await pool.query("SELECT count(*)::int n FROM subscriptions WHERE user_id=$1 AND status NOT IN ('canceled','terminated')",[req.actor!.id]);
  return {enabled:st.enabled,title:st.title,intro:st.intro,defaultInterval:st.defaultInterval,legal:legal(st),promoCodes:st.promoCodes,collectAddress:st.collectAddress,
   plans:await catalog(req.actor!.id,{freeOnly}),freeOnly,canBuy:sell.ok&&access.ok,reason:sell.ok?(access.ok?null:access.reason):sell.reason,activeSubscriptions:limits.rows[0].n,maxActive:st.maxActivePerCustomer};
 });

 app.post('/api/store/checkout',async(req)=>{
  if(req.actor!.role!=='customer'||req.actor!.tokenScopes)fail(403,'Sign in as a customer in your browser to buy.');
  const all=await settings(),st=all.store,bl=all.billing,b=req.body as any;
  const access=await storeAccessFor(req.actor!.id);
  if(!access.ok)fail(403,access.reason!);
  if(st.requireTerms&&b?.acceptTerms!==true)fail(400,'Please accept the terms to continue.');
  const planId=asId(b?.planId),cycle=b?.cycle;
  if(!isInterval(cycle))fail(400,'Choose how often to pay.');
  const plan=(await pool.query("SELECT * FROM plans WHERE id=$1 AND active AND archived_at IS NULL AND visibility IN ('public','hidden')",[planId])).rows[0];
  if(!plan)fail(404,'That plan is not available.');
  const price=(await pool.query('SELECT * FROM plan_prices WHERE plan_id=$1 AND cycle=$2 AND active AND ($3::text IS NULL OR currency=$3) ORDER BY (currency=$4) DESC LIMIT 1',[planId,cycle,b?.currency?String(b.currency).toLowerCase():null,bl.currency])).rows[0];
  if(!price)fail(400,'That payment option is not available for this plan.');
  // Free plans need no payment provider; they only need the store or self-service to be on.
  const freePlan=Number(price.amount)===0&&Number(price.setup_fee)===0;
  if(freePlan){if(!st.enabled&&all.selfService.mode==='off')fail(503,'The store is closed.');}
  else{const sell=await canSell();if(!sell.ok)fail(503,sell.reason||'The store is closed.');}
  if(!bl.currencies.includes(price.currency))fail(400,'That currency is not accepted.');
  // Limits per customer and in stock.
  const mine=Number((await pool.query("SELECT count(*) n FROM subscriptions WHERE user_id=$1 AND plan_id=$2 AND status NOT IN ('canceled','terminated')",[req.actor!.id,planId])).rows[0].n);
  if(mine>=plan.per_customer_max)fail(409,mine?'You already have this plan.':'You cannot buy more of this plan.');
  const total=Number((await pool.query("SELECT count(*) n FROM subscriptions WHERE user_id=$1 AND status NOT IN ('canceled','terminated')",[req.actor!.id])).rows[0].n);
  if(total>=st.maxActivePerCustomer)fail(409,'You have reached the maximum number of subscriptions.');
  const av=await availability(plan);
  if(av.soldOut)fail(409,av.capacity?'This plan is sold out.':'We are out of capacity for this plan right now. Please check back soon.');
  // What the buyer chose for the server: name, location and the settings the plan lets them change.
  const details:any={};
  if(plan.kind==='server'){
   const p=plan.preset||{};
   details.name=b?.name&&p.allowNameChoice!==false?txt(b.name,80):plan.name;
   const locs:string[]=Array.isArray(p.locations)?p.locations:[];
   if(b?.location){const loc=txt(b.location,80);if(locs.length&&!locs.includes(loc))fail(400,'That location is not offered.');details.location=loc;}
   else if(locs.length===1)details.location=locs[0];
   if(b?.variables!==undefined){
    if(!b.variables||typeof b.variables!=='object'||Array.isArray(b.variables))fail(400,'Invalid settings');
    const t=(await pool.query('SELECT editable_variables,variables FROM templates WHERE id=$1',[p.templateId])).rows[0];
    const defs=effectiveDefs(t||{}).filter((d:any)=>d.userEditable&&(p.editableVariables||[]).includes(d.key));
    details.variables={};
    for(const [k,v] of Object.entries(b.variables as Record<string,unknown>)){const d=defs.find((x:any)=>x.key===k);if(!d)fail(400,'That setting cannot be changed for this plan.');details.variables[k]=checkValue(d as any,v);}
   }
  }
  // Trials once per customer per plan.
  let trialDays=price.trial_days;
  if(trialDays>0&&plan.trial_once&&Number((await pool.query('SELECT count(*) n FROM subscriptions WHERE user_id=$1 AND plan_id=$2',[req.actor!.id,planId])).rows[0].n)>0)trialDays=0;
  // Only checkouts that pass every check count, so a typo never uses up the allowance.
  if(await bump(`checkout:${req.actor!.id}`,3600)>bl.checkoutsPerHour)fail(429,'You have started several checkouts. Try again in a little while.');
  const snapshot={planName:plan.name,kind:plan.kind,cycle:price.cycle,amount:Number(price.amount),currency:price.currency,trialDays,setupFee:Number(price.setup_fee),description:plan.description};
  const isFree=snapshot.amount===0&&snapshot.setupFee===0;
  const prov=isFree?null:await activeProvider();
  if(!isFree&&!prov)fail(503,'Payments are not available right now.');
  // Counting stock and writing the order happen under one lock per plan, so two buyers cannot both take the last one.
  const order=await (async()=>{
   const c=await pool.connect();
   try{
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['plan:'+planId]);
    // An earlier unfinished checkout of this customer for this plan is replaced by the new one (a payment that still arrives for it is honoured).
    await c.query("UPDATE orders SET status='canceled' WHERE user_id=$1 AND plan_id=$2 AND status IN ('created','pending')",[req.actor!.id,planId]);
    if(plan.stock!==null){
     const used=Number((await c.query("SELECT (SELECT count(*) FROM subscriptions WHERE plan_id=$1 AND status NOT IN ('canceled','terminated'))+(SELECT count(*) FROM orders WHERE plan_id=$1 AND status IN ('created','pending') AND expires_at>now()) n",[planId])).rows[0].n);
     if(used>=plan.stock)fail(409,'This plan is sold out.');
    }
    const have=Number((await c.query("SELECT (SELECT count(*) FROM subscriptions WHERE user_id=$1 AND plan_id=$2 AND status NOT IN ('canceled','terminated'))+(SELECT count(*) FROM orders WHERE user_id=$1 AND plan_id=$2 AND status IN ('created','pending') AND expires_at>now()) n",[req.actor!.id,planId])).rows[0].n);
    if(have>=plan.per_customer_max)fail(409,'You already have this plan.');
    const row=(await c.query(`INSERT INTO orders(user_id,plan_id,price_id,status,snapshot,details,provider,terms_version,expires_at,livemode)
     VALUES($1,$2,$3,'created',$4,$5,$6,$7,now()+make_interval(hours=>$8),$9) RETURNING id`,
     [req.actor!.id,planId,price.id,JSON.stringify(snapshot),JSON.stringify(details),isFree?'manual':prov!.id,st.requireTerms?all.signup.termsVersion:null,bl.orderExpiryHours,false])).rows[0];
    await c.query('COMMIT');
    return row as {id:string};
   }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })();
  // Free: no payment step; the subscription is created right away.
  if(isFree){
   const subId=await grantManual({userId:req.actor!.id,planId,cycle:price.cycle,serverName:details.name,location:details.location||null,variables:details.variables,actorId:null});
   await pool.query("UPDATE orders SET status='paid',paid_at=now(),subscription_id=$2,provider='manual' WHERE id=$1",[order.id,subId]);
   await audit(req.actor!.id,'store.free','order',order.id,{planId});
   return {free:true,orderId:order.id,subscriptionId:subId};
  }
  const state=await providerState();
  const cust=(await pool.query('SELECT provider_customer_id FROM billing_customers WHERE user_id=$1 AND provider=$2 AND livemode=$3',[req.actor!.id,prov!.id,state.livemode===true])).rows[0];
  let session:Awaited<ReturnType<typeof provider.createCheckout>>|undefined;
  try{
   session=await provider.createCheckout({
    order:{id:order.id,planName:plan.name,description:plan.description,cycle:price.cycle,amount:snapshot.amount,currency:price.currency,trialDays,setupFee:snapshot.setupFee},
    customer:{userId:req.actor!.id,email:req.actor!.email,providerCustomerId:cust?.provider_customer_id||null},
    urls:{success:`${origin()}/?order=${order.id}`,cancel:`${origin()}/?store=1&canceled=${order.id}`},
    options:{automaticTax:st.automaticTax,collectAddress:st.collectAddress,collectTaxId:st.collectTaxId,promoCodes:st.promoCodes},
   });
  }catch(e:any){
   await pool.query("UPDATE orders SET status='failed',error=$2 WHERE id=$1",[order.id,String(e?.message||'error').slice(0,300)]);
   await audit(null,'store.checkout.failed','order',order.id,{error:String(e?.message||'').slice(0,200)});
   fail(502,'We could not start the payment. Please try again in a moment.');
  }
  if(!session||!session.url||!/^https:\/\//.test(session.url)||!session.sessionId){
   await pool.query("UPDATE orders SET status='failed',error='The provider returned no payment page' WHERE id=$1",[order.id]);
   return fail(502,'We could not start the payment. Please try again in a moment.');
  }
  await pool.query("UPDATE orders SET status='pending',provider=$2,provider_session_id=$3,provider_customer_id=$4,livemode=$5,checkout_url=$6 WHERE id=$1",[order.id,prov!.id,session.sessionId,session.customerId||null,session.livemode===true,session.url]);
  await audit(req.actor!.id,'store.checkout','order',order.id,{planId,cycle,amount:snapshot.amount,currency:snapshot.currency});
  return {url:session.url,orderId:order.id};
 });

 // The page the customer returns to polls this until the server exists.
 const lastCheck=new Map<string,number>();
 app.get('/api/store/orders/:id',async(req)=>{
  const id=asId((req.params as any).id);
  const o=(await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2',[id,req.actor!.id])).rows[0];
  if(!o)fail(404,'Order not found');
  if((o.status==='pending'||o.status==='created')&&Date.now()-(lastCheck.get(id)||0)>2500){
   lastCheck.set(id,Date.now());
   if(lastCheck.size>500)lastCheck.delete(lastCheck.keys().next().value as string);
   await completeOrder(id,{reason:'customer returned',source:'customer'}).catch(()=>{});
  }
  const fresh=(await pool.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
  const sub=fresh.subscription_id?await loadSub(fresh.subscription_id):null;
  const server=sub?await serverOf(sub.id):null;
  return {id:fresh.id,status:fresh.status,planName:fresh.snapshot?.planName,amountText:formatMoney(fresh.snapshot?.amount||0,fresh.snapshot?.currency||'eur'),
   subscriptionId:sub?.id||null,subscriptionStatus:sub?.status||null,fulfilment:sub?.fulfilment||null,
   server:server?{id:server.id,name:server.name}:null,checkoutUrl:fresh.status==='pending'&&fresh.expires_at>new Date()?fresh.checkout_url:null};
 });

 // ---- Billing page ----
 const mineSub=async(req:any,id:string)=>{
  const s=await loadSub(asId(id));
  if(!s||s.user_id!==req.actor.id)fail(404,'Subscription not found');
  return s;
 };
 app.get('/api/billing',async(req)=>{
  const bl=(await settings()).billing;
  const rows=(await pool.query("SELECT id FROM subscriptions WHERE user_id=$1 ORDER BY (status IN ('canceled','terminated')),created_at DESC LIMIT 100",[req.actor!.id])).rows;
  const subs=[];
  for(const r of rows){
   const s=await loadSub(r.id);if(!s)continue;
   const srv=await serverOf(s.id);
   const ends=s.cancel_at_period_end&&s.current_period_end?s.current_period_end:null;
   subs.push({id:s.id,planId:s.plan_id,planName:s.plan_name,kind:s.plan_kind,status:s.status,cycle:s.cycle,intervalText:INTERVALS[s.cycle as Interval]?.adjective||s.cycle,amount:Number(s.amount),currency:s.currency,amountText:formatMoney(s.amount,s.currency),
    provider:s.provider,comped:s.provider==='manual',currentPeriodEnd:s.current_period_end,trialEnd:s.trial_end,cancelAtPeriodEnd:s.cancel_at_period_end,endsAt:ends||s.manual_ends_at||null,pastDueSince:s.past_due_since,
    suspendAt:s.past_due_since?new Date(new Date(s.past_due_since).getTime()+bl.suspendAfterDays*86400000):null,
    retentionUntil:s.retention_until,fulfilment:s.fulfilment,fulfilmentError:s.fulfilment==='failed'?'We are still setting this up.':null,hold:(s.holds||[]).length>0,
    server:srv?{id:srv.id,name:srv.name,status:srv.observed_status,suspendedReason:srv.suspended_reason}:null,createdAt:s.created_at,
    can:{cancel:bl.allowCustomerCancel&&['trialing','active','past_due'].includes(s.status)&&!s.cancel_at_period_end&&s.provider!=='manual'||false,resume:bl.allowResume&&!!s.cancel_at_period_end&&['trialing','active','past_due'].includes(s.status),change:bl.allowPlanChange&&['trialing','active'].includes(s.status)&&s.provider!=='manual',pay:['past_due','suspended'].includes(s.status)&&s.provider!=='manual'}});
  }
  const invoices=(await pool.query('SELECT i.id,i.number,i.status,i.amount_due,i.amount_paid,i.amount_refunded,i.currency,i.created_at,i.paid_at,i.hosted_url,i.pdf_url,i.period_start,i.period_end,p.name AS plan FROM invoices i LEFT JOIN subscriptions s ON s.id=i.subscription_id LEFT JOIN plans p ON p.id=s.plan_id WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 100',[req.actor!.id])).rows
   .map((i:any)=>({id:i.id,number:i.number,status:i.status,plan:i.plan,amountText:formatMoney(i.amount_due,i.currency),paidText:formatMoney(i.amount_paid,i.currency),refundedText:Number(i.amount_refunded)?formatMoney(i.amount_refunded,i.currency):null,createdAt:i.created_at,paidAt:i.paid_at,url:i.hosted_url,pdf:i.pdf_url}));
  const p=await activeProvider();
  return {enabled:(await settings()).store.enabled,subscriptions:subs,invoices,portal:!!p&&subs.some(s=>s.provider!=='manual'),allowCancel:bl.allowCustomerCancel,cancelNow:bl.cancelDefault==='immediate'};
 });
 app.post('/api/billing/portal',async(req)=>{
  if(req.actor!.tokenScopes)fail(403,'Browser session required');
  const p=await activeProvider();
  if(!p)fail(503,'Payments are not available right now.');
  const state=await providerState();
  const cust=(await pool.query('SELECT provider_customer_id FROM billing_customers WHERE user_id=$1 AND provider=$2 AND livemode=$3',[req.actor!.id,p!.id,state.livemode===true])).rows[0];
  if(!cust)fail(404,'You have no payment details on file yet.');
  const r=await provider.createPortal(cust.provider_customer_id,`${origin()}/billing`);
  if(!r?.url||!/^https:\/\//.test(r.url))fail(502,'The billing portal is not available right now.');
  await audit(req.actor!.id,'billing.portal','user',req.actor!.id);
  return {url:r.url};
 });
 app.post('/api/billing/subscriptions/:id/cancel',async(req)=>{
  if(req.actor!.tokenScopes)fail(403,'Browser session required');
  const bl=(await settings()).billing;
  const s=await mineSub(req,(req.params as any).id);
  if(!bl.allowCustomerCancel)fail(403,'Cancelling yourself is turned off. Contact support.');
  const when=(req.body as any)?.when==='now'&&bl.cancelDefault==='immediate'?'now':'period_end';
  if(s.provider==='manual')fail(403,'This subscription was granted by the provider. Contact support to end it.');
  const out=await cancelSubscription(s.id,when,{reason:'cancelled by the customer',source:'customer',actor:req.actor!.id});
  return {ok:true,status:out?.status,endsAt:out?.current_period_end,cancelAtPeriodEnd:out?.cancel_at_period_end};
 });
 app.post('/api/billing/subscriptions/:id/resume',async(req)=>{
  if(req.actor!.tokenScopes)fail(403,'Browser session required');
  const s=await mineSub(req,(req.params as any).id);
  if(!(await settings()).billing.allowResume)fail(403,'Resuming yourself is turned off. Contact support.');
  const out=await resumeSubscription(s.id,{reason:'resumed by the customer',source:'customer',actor:req.actor!.id});
  return {ok:true,status:out?.status};
 });
 app.post('/api/billing/subscriptions/:id/change',async(req)=>{
  if(req.actor!.tokenScopes)fail(403,'Browser session required');
  const s=await mineSub(req,(req.params as any).id),b=req.body as any;
  if(!(await settings()).billing.allowPlanChange)fail(403,'Changing plans yourself is turned off. Contact support.');
  if(!isInterval(b?.cycle))fail(400,'Choose how often to pay.');
  if(await bump(`change:${req.actor!.id}`,3600)>10)fail(429,'Too many changes. Try again later.');
  const out=await changePlan(s.id,asId(b?.planId),b.cycle,{source:'customer',actor:req.actor!.id,customer:true});
  return {ok:true,status:out?.status,planName:out?.plan_name};
 });
 app.get('/api/billing/preview-change',async(req)=>{
  const q=req.query as any;
  const s=await mineSub(req,q?.subscriptionId);
  return changePlan(s.id,asId(q?.planId),isInterval(q?.cycle)?q.cycle:fail(400,'cycle is required'),{source:'customer',actor:req.actor!.id,customer:true,dryRun:true});
 });
 void looksLikeEmail;void fmtDate;
}
