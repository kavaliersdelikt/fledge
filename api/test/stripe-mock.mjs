// A small stand-in for the Stripe API, enough for the bundled Stripe plugin: checkout sessions,
// subscriptions, invoices, charges, refunds, products, the customer portal and signed webhooks.
// It also has "controls" that play the customer (complete a checkout, fail a renewal, dispute a
// charge) and send the webhooks Stripe would send, signed exactly like Stripe signs them.
import {createServer} from 'node:http';
import {createHmac,randomBytes} from 'node:crypto';

const rnd=(p)=>`${p}_${randomBytes(9).toString('hex')}`;
const now=()=>Math.floor(Date.now()/1000);

function parseForm(text){
 const out={};
 for(const pair of text.split('&').filter(Boolean)){
  const [rawK,rawV='']=pair.split('=');
  const k=decodeURIComponent(rawK.replace(/\+/g,' ')),v=decodeURIComponent(rawV.replace(/\+/g,' '));
  const path=k.replace(/\]/g,'').split('[');
  let cur=out;
  for(let i=0;i<path.length;i++){
   const key=path[i],last=i===path.length-1;
   if(last)cur[key]=v;
   else{cur[key]=cur[key]??(/^\d+$/.test(path[i+1])?[]:{});cur=cur[key];}
  }
 }
 return out;
}

export async function startStripeMock({webhookUrl,secret='whsec_testsecret',livemode=false}={}){
 const S={customers:{},sessions:{},subs:{},invoices:{},charges:{},refunds:{},products:{},configs:{},requests:[],portalNeedsConfig:true,failNext:null,sent:[]};
 let invoiceNo=1000;

 const subObject=(s)=>({...s,object:'subscription',livemode});
 const expandInvoice=(inv,expand=[])=>{
  const o={...inv,object:'invoice',livemode};
  if(expand.some(e=>e==='charge'||e.endsWith('.charge'))&&o.charge)o.charge={...S.charges[o.charge],object:'charge'};
  return o;
 };
 const toExpand=(q)=>{const e=q.expand;return Array.isArray(e)?e:e?Object.values(e):[];};

 const newInvoice=(sub,{amount,paid,status})=>{
  const inv={id:rnd('in'),subscription:sub.id,customer:sub.customer,status,number:`MOCK-${++invoiceNo}`,amount_due:amount,amount_paid:paid?amount:0,currency:sub.currency,period_start:sub.current_period_start,period_end:sub.current_period_end,
   hosted_invoice_url:`https://invoice.stripe.test/i/${invoiceNo}`,invoice_pdf:`https://invoice.stripe.test/i/${invoiceNo}.pdf`,status_transitions:{paid_at:paid?now():null},charge:null,attempt_count:paid?1:0,description:null};
  if(paid&&amount>0){const ch={id:rnd('ch'),amount,amount_refunded:0,invoice:inv.id,currency:sub.currency};S.charges[ch.id]=ch;inv.charge=ch.id;}
  S.invoices[inv.id]=inv;sub.latest_invoice=inv.id;return inv;
 };

 const send=async(type,object,opts={})=>{
  const evt={id:rnd('evt'),object:'event',type,livemode,created:now(),data:{object}};
  const body=JSON.stringify(evt);
  const t=opts.timestamp??now();
  let v1=createHmac('sha256',opts.secret??secret).update(`${t}.${body}`).digest('hex');
  if(opts.tamper)v1=v1.replace(/^./,c=>c==='a'?'b':'a');
  const res=await fetch(webhookUrl,{method:'POST',headers:{'content-type':'application/json','stripe-signature':opts.noSignature?'':`t=${t},v1=${v1}`},body:opts.alteredBody??body});
  S.sent.push({type,id:evt.id,status:res.status});
  return {status:res.status,id:evt.id,body:await res.text().catch(()=>'')};
 };

 const server=createServer((req,res)=>{
  let raw='';req.on('data',d=>raw+=d);
  req.on('end',()=>{
   const url=new URL(req.url,'http://x'),q=parseForm(url.search.slice(1));
   const params=raw?parseForm(raw):{};
   S.requests.push({method:req.method,path:url.pathname,params:{...q,...params},headers:req.headers});
   const key=(req.headers.authorization||'').replace(/^Bearer /,'');
   const json=(code,obj)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
   const err=(code,message,errCode='invalid_request_error')=>json(code,{error:{message,type:errCode==='api_error'?'api_error':'invalid_request_error',code:errCode}});
   if(!/^(sk|rk)_test_/.test(key))return err(401,'Invalid API Key provided','api_key_invalid');
   if(S.failNext){const f=S.failNext;S.failNext=null;return err(f.code||402,f.message||'Your card was declined.');}
   const p=url.pathname,m=req.method;
   try{
    if(m==='GET'&&p==='/v1/account')return json(200,{id:'acct_mock',object:'account',settings:{dashboard:{display_name:'Mock Hosting'}}});
    if(m==='GET'&&p==='/v1/customers')return json(200,{object:'list',data:[]});
    if(m==='POST'&&p==='/v1/checkout/sessions'){
     const id=rnd('cs_test');
     if(!params.client_reference_id||!params.success_url)return err(400,'Missing required param');
     const s={id,object:'checkout.session',status:'open',payment_status:'unpaid',mode:params.mode,client_reference_id:params.client_reference_id,metadata:params.metadata||{},
      customer:params.customer||null,customer_email:params.customer_email||null,subscription:null,url:`https://checkout.stripe.test/c/pay/${id}`,livemode,params};
     S.sessions[id]=s;return json(200,s);
    }
    let mt;
    if(m==='GET'&&(mt=p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))){const s=S.sessions[mt[1]];return s?json(200,s):err(404,'No such checkout.session','resource_missing');}
    if(m==='POST'&&p==='/v1/billing_portal/sessions'){
     if(S.portalNeedsConfig&&!params.configuration)return err(400,'You can’t create a portal session in test mode until you save your customer portal settings in test mode at https://dashboard.stripe.com/test/settings/billing/portal. No configuration provided and your test mode default configuration has not been created.');
     if(!params.customer||!params.return_url)return err(400,'Missing required param');
     return json(200,{id:rnd('bps'),object:'billing_portal.session',url:`https://billing.stripe.test/p/session/${rnd('x')}`,customer:params.customer});
    }
    if(m==='POST'&&p==='/v1/billing_portal/configurations'){const c={id:rnd('bpc'),object:'billing_portal.configuration',params};S.configs[c.id]=c;S.portalNeedsConfig=false;return json(200,c);}
    if(m==='POST'&&p==='/v1/products'){const pr={id:rnd('prod'),object:'product',name:params.name};S.products[pr.id]=pr;return json(200,pr);}
    if((mt=p.match(/^\/v1\/subscriptions\/([^/]+)$/))){
     const s=S.subs[mt[1]];if(!s)return err(404,'No such subscription','resource_missing');
     if(m==='GET'){const o=subObject(s);if(toExpand(q).some(e=>e.startsWith('latest_invoice')))o.latest_invoice=expandInvoice(S.invoices[s.latest_invoice],toExpand(q));return json(200,o);}
     if(m==='POST'){
      if(params.cancel_at_period_end!==undefined)s.cancel_at_period_end=params.cancel_at_period_end==='true';
      if(params.items){
       const it=params.items[0],pd=it.price_data;
       if(!pd.product)return err(400,'price_data requires a product id');
       s.items.data[0].price={unit_amount:Number(pd.unit_amount),recurring:{interval:pd.recurring.interval,interval_count:Number(pd.recurring.interval_count)},product:pd.product};s.currency=pd.currency;
       s.changes=(s.changes||0)+1;
      }
      return json(200,subObject(s));
     }
     if(m==='DELETE'){s.status='canceled';s.canceled_at=now();s.ended_at=now();return json(200,subObject(s));}
    }
    if(m==='GET'&&(mt=p.match(/^\/v1\/invoices\/([^/]+)$/))){const i=S.invoices[mt[1]];return i?json(200,expandInvoice(i,toExpand(q))):err(404,'No such invoice','resource_missing');}
    if(m==='GET'&&(mt=p.match(/^\/v1\/charges\/([^/]+)$/))){const c=S.charges[mt[1]];return c?json(200,{...c,object:'charge'}):err(404,'No such charge','resource_missing');}
    if(m==='POST'&&p==='/v1/refunds'){
     const c=S.charges[params.charge];if(!c)return err(404,'No such charge','resource_missing');
     const amount=params.amount?Number(params.amount):c.amount-c.amount_refunded;
     if(amount>c.amount-c.amount_refunded)return err(400,'Refund amount is greater than the charge');
     c.amount_refunded+=amount;const r={id:rnd('re'),object:'refund',amount,charge:c.id};S.refunds[r.id]=r;return json(200,r);
    }
    return err(404,`Unrecognized request URL (${m}: ${p})`,'resource_missing');
   }catch(e){console.error('Stripe mock request failed:',e);return err(500,'Internal server error','api_error');}
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));

 // ---- Controls that play the customer and Stripe's billing engine ----
 const controls={
  state:S,port:server.address().port,secret,send,
  /** The customer pays on the hosted page. */
  async completeCheckout(sessionId,{webhooks=true,trial}={}){
   const s=S.sessions[sessionId];if(!s)throw Error('no such session');
   const p=s.params,item=p.line_items[0].price_data,setup=p.line_items[1]?.price_data;
   const customer=s.customer||rnd('cus');
   S.customers[customer]={id:customer,email:s.customer_email};
   const trialDays=Number(p.subscription_data?.trial_period_days||0)||(trial?1:0);
   const start=now(),months=item.recurring.interval==='year'?12:Number(item.recurring.interval_count||1);
   const sub={id:rnd('sub'),status:trialDays?'trialing':'active',current_period_start:start,current_period_end:trialDays?start+trialDays*86400:start+months*30*86400,cancel_at_period_end:false,
    trial_end:trialDays?start+trialDays*86400:null,canceled_at:null,ended_at:null,currency:item.currency,customer,metadata:p.subscription_data?.metadata||{},
    items:{data:[{id:rnd('si'),quantity:1,price:{unit_amount:Number(item.unit_amount),recurring:{interval:item.recurring.interval,interval_count:Number(item.recurring.interval_count||1)},product:rnd('prod')}}]},latest_invoice:null};
   S.subs[sub.id]=sub;
   const total=trialDays?0:Number(item.unit_amount)+Number(setup?.unit_amount||0);
   const inv=newInvoice(sub,{amount:total,paid:true,status:'paid'});
   s.status='complete';s.payment_status=total===0?'no_payment_required':'paid';s.subscription=sub.id;s.customer=customer;
   if(webhooks){
    await send('checkout.session.completed',s);
    await send('customer.subscription.created',subObject(sub));
    await send('invoice.paid',expandInvoice(inv));
   }
   return {subscriptionId:sub.id,customerId:customer,invoiceId:inv.id};
  },
  async expireCheckout(sessionId){const s=S.sessions[sessionId];s.status='expired';await send('checkout.session.expired',s);},
  /** A renewal fails. */
  async failRenewal(subId,{webhooks=true}={}){
   const sub=S.subs[subId];sub.status='past_due';
   const inv=newInvoice(sub,{amount:sub.items.data[0].price.unit_amount,paid:false,status:'open'});inv.attempt_count=1;
   if(webhooks){await send('invoice.payment_failed',expandInvoice(inv));await send('customer.subscription.updated',subObject(sub));}
   return inv.id;
  },
  /** The customer fixes their card and the open invoice is paid. */
  async payOverdue(subId,{webhooks=true}={}){
   const sub=S.subs[subId],inv=S.invoices[sub.latest_invoice];
   inv.status='paid';inv.amount_paid=inv.amount_due;inv.status_transitions.paid_at=now();
   const ch={id:rnd('ch'),amount:inv.amount_due,amount_refunded:0,invoice:inv.id,currency:inv.currency};S.charges[ch.id]=ch;inv.charge=ch.id;
   sub.status='active';sub.current_period_start=now();sub.current_period_end=now()+30*86400;
   if(webhooks){await send('invoice.paid',expandInvoice(inv));await send('customer.subscription.updated',subObject(sub));}
  },
  /** A normal renewal. */
  async renew(subId,{webhooks=true}={}){
   const sub=S.subs[subId];sub.current_period_start=sub.current_period_end;sub.current_period_end=sub.current_period_start+30*86400;sub.status='active';sub.trial_end=sub.trial_end;
   const inv=newInvoice(sub,{amount:sub.items.data[0].price.unit_amount,paid:true,status:'paid'});
   if(webhooks){await send('invoice.paid',expandInvoice(inv));await send('customer.subscription.updated',subObject(sub));}
   return inv.id;
  },
  /** The period of a subscription set to cancel ends. */
  async endCancelled(subId,{webhooks=true}={}){
   const sub=S.subs[subId];sub.status='canceled';sub.ended_at=now();sub.canceled_at=sub.canceled_at||now();
   if(webhooks)await send('customer.subscription.deleted',subObject(sub));
  },
  /** Stripe gives up on collecting. */
  async markUnpaid(subId){const sub=S.subs[subId];sub.status='unpaid';await send('customer.subscription.updated',subObject(sub));},
  async dispute(subId,phase='created',won=false){
   const sub=S.subs[subId],inv=S.invoices[sub.latest_invoice],id=S.disputeId||(S.disputeId=rnd('dp'));
   await send(phase==='created'?'charge.dispute.created':'charge.dispute.closed',{id,object:'dispute',charge:inv.charge,status:phase==='created'?'needs_response':won?'won':'lost'});
  },
  async refundEvent(invoiceId){const inv=S.invoices[invoiceId];await send('charge.refunded',{...S.charges[inv.charge],object:'charge',invoice:inv.id});},
  requests(path,method){return S.requests.filter(r=>(!path||r.path.startsWith(path))&&(!method||r.method===method));},
  stop(){return new Promise(r=>server.close(()=>r()));},
 };
 return controls;
}
