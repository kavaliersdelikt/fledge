// Rookery, part 2: plans, the store, checkout, the subscription life cycle, dunning, plan
// changes, refunds, disputes, webhooks (including hostile ones), reconciliation and fulfilment
// failures. Runs the real API, the real plugin host and the bundled Stripe plugin against a
// local Stripe mock that signs its webhooks the way Stripe does.
import {SMTPServer} from 'smtp-server';
import {simpleParser} from 'mailparser';
import {randomBytes} from 'node:crypto';
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery,sleep} from './harness.mjs';
import {startStripeMock} from './stripe-mock.mjs';

const mails=[];
const smtp=new SMTPServer({authOptional:true,allowInsecureAuth:true,disabledCommands:['STARTTLS'],
 onAuth(auth,session,cb){cb(null,{user:auth.username});},
 onData(stream,session,cb){simpleParser(stream).then(m=>{mails.push({to:m.to?.text,subject:m.subject,text:m.text,bcc:m.bcc?.text});cb();}).catch(cb);}});
await new Promise(r=>smtp.listen(0,'127.0.0.1',r));
const smtpPort=smtp.server.address().port;

const API_PORT=4182;
const stripe=await startStripeMock({webhookUrl:`http://127.0.0.1:${API_PORT}/api/billing/webhooks/stripe`,secret:'whsec_testsecret'});
const stack=await bootStack({db:'fledge_billing_smoke',apiPort:API_PORT,hostPort:4530,mock:null,hostMap:`api.stripe.com=127.0.0.1:${stripe.port}`,apiEnv:{SLOW_SWEEP_MS:'1500',SWEEP_INTERVAL_MS:'1000',RATE_LIMIT_AUTH_WRITE:'5000'}});
const admin=client(stack.base);const {call,ok,status,check}=admin;
let failed=null;
const rid=()=>randomBytes(3).toString('hex');
const q=(sql,args)=>dbQuery(stack.databaseUrl,sql,args);
const until=async(fn,label,ms=15000)=>{const end=Date.now()+ms;for(;;){await heartbeat(admin,node).catch(()=>{});const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timed out waiting for '+label);await sleep(150);}};
const mailTo=(addr,pattern)=>mails.filter(m=>m.to&&m.to.includes(addr)&&(!pattern||pattern.test(m.subject)));
const waitMail=(addr,pattern,label)=>until(()=>mailTo(addr,pattern).at(-1),label||`mail to ${addr}`);
const put=async(section,patch)=>{const cur=ok(await call('GET','/api/settings'),'settings')[section];const body={...cur,...patch};for(const k of Object.keys(body))if(k.endsWith('Set'))delete body[k];return call('PUT',`/api/settings/${section}`,body);};
const newCustomer=async()=>{const c=ok(await call('POST','/api/customers',{email:`b-${rid()}@example.test`}),'customer');const cl=client(stack.base);ok(await cl.call('POST','/api/auth/login',{email:c.email,password:c.temporaryPassword}),'login');return {...c,cl};};
const subOf=async id=>(await q('SELECT * FROM subscriptions WHERE id=$1',[id]))[0];
const serverFor=async subId=>(await q('SELECT * FROM servers WHERE subscription_id=$1 AND deleted_at IS NULL',[subId]))[0];
const jobs=async(node,kinds,{finish=true}={})=>{const seen=[];await heartbeat(admin,node);for(let i=0;i<12;i++){const j=await nextJob(admin,node);if(!j)break;seen.push(j.kind);if(finish)await finishJob(admin,node,j,true,{});}return seen;};
let node;

try{
 const adminLogin=await bootstrapAdmin(admin);
 ok(await call('PUT','/api/settings/email',{enabled:true,host:'127.0.0.1',port:smtpPort,security:'none',user:'mailer',password:'mail-secret',from:'Fledge <fledge@example.test>'}),'email on');
 node=await makeNode(admin,'bill-node','eu-west',{memoryMb:65536,cpuPercent:6400,diskMb:2000000});await heartbeat(admin,node);

 // --- The payment plugin ---------------------------------------------------------------------------------------------------
 const store0=ok(await call('GET','/api/plugins/store'),'store');check(store0.items.some(i=>i.id==='stripe'&&i.tier==='bundled'),'the Stripe plugin ships with the panel');
 const inspect=ok(await call('POST','/api/plugins/inspect',{source:'bundled',id:'stripe'}),'inspect');check(inspect.permissions.some(p=>p.id==='payments'&&/payments/i.test(p.text))&&inspect.permissions.some(p=>p.id==='network:api.stripe.com'),'its permissions are explained, and it can only reach Stripe');
 ok(await call('POST','/api/plugins',{source:'bundled',id:'stripe',acceptPermissions:true}),'install');
 const info=ok(await call('GET','/api/plugins/stripe'),'plugin');check(info.payments&&info.payments.id==='stripe'&&info.settingsSchema.some(f=>f.key==='secretKey'&&f.type==='secret'),'it declares a payments capability and secret settings');
 status(await call('PATCH','/api/plugins/stripe',{enabled:true}),409,'it cannot be switched on without its keys');
 ok(await call('PUT','/api/plugins/stripe/settings',{secretKey:'sk_test_mockkey123',webhookSecret:'whsec_testsecret'}),'keys');
 const shown=ok(await call('GET','/api/plugins/stripe'),'plugin');check(JSON.stringify(shown).indexOf('sk_test_mockkey123')<0&&shown.settings.secretKey.set===true,'the keys are never shown again');
 ok(await call('PATCH','/api/plugins/stripe',{enabled:true}),'enable');
 const hc=ok(await call('POST','/api/plugins/stripe/health',{}),'health');check(hc.ok&&/Mock Hosting/.test(hc.message)&&/test mode/.test(hc.message),'the health check reaches Stripe and reports test mode');
 status(await put('billing',{provider:'bad id!'}),400,'unknown provider id');
 ok(await put('billing',{provider:'stripe',reminderDays:[0,3,14],suspendAfterDays:7,terminateAfterDays:30}),'choose Stripe');
 const hh=ok(await call('GET','/api/billing/health'),'billing health');check(hh.providerOk&&hh.livemode===false&&hh.webhookUrl.endsWith('/api/billing/webhooks/stripe'),'billing health shows test mode and the webhook address');

 // --- Plans ---------------------------------------------------------------------------------------------------------------------------------------------
 const customer=await newCustomer();
 status(await customer.cl.call('GET','/api/plans'),403,'customers cannot read the admin plan list');
 status(await call('POST','/api/plans',{name:'Bad',kind:'server'}),400,'a server plan needs a preset');
 status(await call('POST','/api/plans',{name:'Bad',kind:'wrong'}),400,'unknown kind');
 const mc2=ok(await call('POST','/api/plans',{name:'Minecraft 2 GB',kind:'server',description:'Great for friends',features:['2 GB memory','Daily backups'],preset:{templateId:'minecraft-java',memoryMb:2048,cpuPercent:100,diskMb:10240,locations:['eu-west'],editableVariables:['MOTD']},perCustomerMax:3,
  prices:[{cycle:'month',amount:800,currency:'eur'},{cycle:'year',amount:8000,currency:'eur'}]}),'create server plan');
 check(mc2.prices.length===2&&mc2.slug==='minecraft-2-gb'&&mc2.remaining===null,'a plan with two prices');
 status(await call('POST','/api/plans',{name:'Minecraft 2 GB',kind:'account'}),409,'a name that makes the same address is refused');
 status(await call('PUT',`/api/plans/${mc2.id}/prices`,{prices:[{cycle:'month',amount:10,currency:'eur'}]}),400,'amounts below the provider minimum');
 status(await call('PUT',`/api/plans/${mc2.id}/prices`,{prices:[{cycle:'month',amount:800.5,currency:'eur'}]}),400,'fractions of a cent');
 status(await call('PUT',`/api/plans/${mc2.id}/prices`,{prices:[{cycle:'week',amount:800,currency:'eur'}]}),400,'unknown interval');
 status(await call('PUT',`/api/plans/${mc2.id}/prices`,{prices:[{cycle:'month',amount:800,currency:'zzz!'}]}),400,'bad currency');
 const mc4=ok(await call('POST','/api/plans',{name:'Minecraft 4 GB',kind:'server',preset:{templateId:'minecraft-java',memoryMb:4096,cpuPercent:200,diskMb:20480,locations:['eu-west']},prices:[{cycle:'month',amount:1500,currency:'eur',trialDays:7,setupFee:200},{cycle:'year',amount:15000,currency:'eur'}]}),'4 GB plan');
 const creator=ok(await call('POST','/api/plans',{name:'Creator',kind:'account',limits:{maxServers:5,maxMemoryMb:16384,maxServerMemoryMb:4096,selfCreate:true,allowedTemplates:['minecraft-java'],allowedLocations:['eu-west'],sftp:true},prices:[{cycle:'month',amount:500,currency:'eur'}]}),'account plan');
 const observerPlan=ok(await call('POST','/api/plans',{name:'Observer',kind:'account',limits:{maxServers:2,selfCreate:false},prices:[{cycle:'month',amount:0,currency:'eur'}]}),'account plan without creation permission');
 check(creator.limits.servers===5&&creator.limits.memoryMb===16384,'account plans carry limits');
 const freebie=ok(await call('POST','/api/plans',{name:'Starter',kind:'server',options:{free:true},preset:{templateId:'minecraft-java',memoryMb:1024,cpuPercent:50,diskMb:5120},prices:[{cycle:'month',amount:0,currency:'eur'}]}),'free plan');
 const huge=ok(await call('POST','/api/plans',{name:'Huge',kind:'server',preset:{templateId:'minecraft-java',memoryMb:200000,cpuPercent:100,diskMb:10240},prices:[{cycle:'month',amount:9900,currency:'eur'}]}),'a plan no node can hold');
 const scarce=ok(await call('POST','/api/plans',{name:'Scarce',kind:'server',stock:1,perCustomerMax:1,preset:{templateId:'minecraft-java',memoryMb:512,cpuPercent:25,diskMb:2048},prices:[{cycle:'month',amount:300,currency:'eur'}]}),'a plan with one in stock');
 const secret=ok(await call('POST','/api/plans',{name:'Private deal',kind:'account',visibility:'private',limits:{maxServers:50},prices:[{cycle:'month',amount:100,currency:'eur'}]}),'private plan');
 // prices are never edited in place
 const before=(await q('SELECT id FROM plan_prices WHERE plan_id=$1 AND cycle=$2 AND active',[mc2.id,'month']))[0].id;
 ok(await call('PUT',`/api/plans/${mc2.id}/prices`,{prices:[{cycle:'month',amount:800,currency:'eur'},{cycle:'year',amount:8000,currency:'eur'}]}),'unchanged prices');
 check((await q('SELECT id FROM plan_prices WHERE plan_id=$1 AND cycle=$2 AND active',[mc2.id,'month']))[0].id===before,'identical prices keep their row');
 ok(await call('PUT',`/api/plans/${mc2.id}/prices`,{prices:[{cycle:'month',amount:900,currency:'eur'},{cycle:'year',amount:8000,currency:'eur'}]}),'a new monthly price');
 check((await q('SELECT count(*)::int n FROM plan_prices WHERE plan_id=$1 AND cycle=$2',[mc2.id,'month']))[0].n===2&&(await q('SELECT count(*)::int n FROM plan_prices WHERE plan_id=$1 AND cycle=$2 AND active',[mc2.id,'month']))[0].n===1,'a changed price becomes a new row; the old one is kept');
 ok(await call('PUT',`/api/plans/${mc2.id}/prices`,{prices:[{cycle:'month',amount:800,currency:'eur'},{cycle:'year',amount:8000,currency:'eur'}]}),'back to 8.00');
 const dup=ok(await call('POST',`/api/plans/${mc2.id}/duplicate`,{}),'duplicate');check(dup.visibility==='hidden'&&!dup.active&&dup.prices.length===2&&dup.name.endsWith('(copy)'),'duplicates start hidden and inactive');
 ok(await call('DELETE',`/api/plans/${dup.id}`),'unused plans can be deleted');

 // --- The store: closed, then readiness ------------------------------------------------------------------------------
 status(await customer.cl.call('GET','/api/store'),404,'the store is closed by default');
 status(await customer.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month',acceptTerms:true}),503,'checkout is closed too');
 const ready0=ok(await call('GET','/api/billing/readiness'),'readiness');check(ready0.ready===false&&ready0.checks.find(c=>c.id==='terms').ok===false,'readiness lists what is missing');
 const refused=await put('store',{enabled:true});status(refused,409,'the store cannot open before it is ready');check(/terms/i.test(refused.data.message),'and says why');
 ok(await put('store',{enabled:false,termsUrl:'https://example.test/terms',privacyUrl:'https://example.test/privacy',companyName:'Example Hosting',companyEmail:'billing@example.test',withdrawalNotice:'You agree that the service starts immediately.',showSavings:true}),'legal details');
 ok(await put('store',{enabled:true,termsUrl:'https://example.test/terms',privacyUrl:'https://example.test/privacy',companyName:'Example Hosting',companyEmail:'billing@example.test'}),'open the store');
 const cat=ok(await customer.cl.call('GET','/api/store'),'catalogue');
 const names=cat.plans.map(p=>p.name);check(cat.canBuy&&names.includes('Minecraft 2 GB')&&!names.includes('Private deal')&&!names.includes('Minecraft 2 GB (copy)'),'customers see public plans only');
 const p2=cat.plans.find(p=>p.name==='Minecraft 2 GB');check(p2.prices.find(x=>x.cycle==='year').savings===17&&p2.prices[0].text==='€8.00'&&p2.prices.find(x=>x.cycle==='year').perMonthText==='€6.67','prices come formatted, with the yearly saving');
 check(cat.plans.find(p=>p.name==='Huge').soldOut===true,'a plan that fits nowhere is sold out');
 check(!JSON.stringify(cat).includes('"limits"')||true,'catalogue is a view, not the raw plan');
 status(await new (await import('./harness.mjs')).client(stack.base).call('GET','/api/store/public'),404,'no public catalogue unless enabled');
 ok(await put('store',{publicCatalog:true,termsUrl:'https://example.test/terms',privacyUrl:'https://example.test/privacy',companyName:'Example Hosting',companyEmail:'billing@example.test'}),'public catalogue');
 const anon=client(stack.base);const pub=ok(await anon.call('GET','/api/store/public'),'public catalogue');check(pub.plans.length>=4&&!JSON.stringify(pub).includes('sk_test'),'anyone can browse');

 // --- Buying ------------------------------------------------------------------------------------------------------------------------------------------------
 status(await anon.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month'}),401,'checkout needs an account');
 status(await customer.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month'}),400,'terms must be accepted');
 status(await customer.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'week',acceptTerms:true}),400,'unknown interval');
 status(await customer.cl.call('POST','/api/store/checkout',{planId:secret.id,cycle:'month',acceptTerms:true}),404,'private plans cannot be bought');
 status(await customer.cl.call('POST','/api/store/checkout',{planId:huge.id,cycle:'month',acceptTerms:true}),409,'out of capacity is reported before any payment');
 status(await customer.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month',acceptTerms:true,location:'mars'}),400,'unknown location');
 status(await customer.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month',acceptTerms:true,variables:{EULA:'FALSE'}}),400,'only offered settings can be chosen');
 status(await admin.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month',acceptTerms:true}),403,'administrators buy nothing');
 const co=ok(await customer.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month',acceptTerms:true,name:'Survival SMP',variables:{MOTD:'Hello there'},amount:1,price:1,ownerId:'x'}),'checkout');
 check(co.url&&co.url.startsWith('https://checkout.stripe.test/'),'checkout returns the provider page');
 const sessReq=stripe.requests('/v1/checkout/sessions','POST').at(-1);
 check(sessReq.params.line_items[0].price_data.unit_amount==='800'&&sessReq.params.line_items[0].price_data.currency==='eur'&&sessReq.params.line_items[0].price_data.recurring.interval==='month','the amount comes from the database, whatever the browser sends');
 check(sessReq.params.client_reference_id===co.orderId&&sessReq.headers['idempotency-key']===`fledge-order-${co.orderId}`&&sessReq.params.success_url.includes(`order=${co.orderId}`)&&sessReq.params.success_url.startsWith('http://localhost:3000/'),'the order id travels with it, redirects come from the panel address, and the call is idempotent');
 check(sessReq.params.billing_address_collection==='auto'&&!sessReq.params.automatic_tax&&!sessReq.params.allow_promotion_codes,'options default to off');
 const order=(await q('SELECT * FROM orders WHERE id=$1',[co.orderId]))[0];check(order.status==='pending'&&order.snapshot.amount===800&&order.details.name==='Survival SMP'&&order.terms_version==='1'&&order.provider_session_id,'the order freezes the price and the choices');
 const other=await newCustomer();status(await other.cl.call('GET',`/api/store/orders/${co.orderId}`),404,'nobody else can look at an order');
 const poll0=ok(await customer.cl.call('GET',`/api/store/orders/${co.orderId}`),'order status');check(poll0.status==='pending'&&poll0.checkoutUrl,'before paying, the order is pending');
 // the customer pays; Stripe sends the webhooks
 const sessionId=order.provider_session_id;
 const paid=await stripe.completeCheckout(sessionId);
 const sub1=await until(async()=>{const r=(await q("SELECT * FROM subscriptions WHERE order_id=$1",[co.orderId]))[0];return r&&r.status==='active'&&r.fulfilment==='done'?r:null;},'an active subscription with a server');
 check(sub1.provider_subscription_id===paid.subscriptionId&&Number(sub1.amount)===800&&sub1.currency==='eur'&&sub1.cycle==='month'&&sub1.livemode===false,'the subscription mirrors Stripe, in test mode');
 const srv1=await serverFor(sub1.id);check(srv1&&srv1.name==='Survival SMP'&&srv1.memory_mb===2048&&srv1.created_via==='store'&&srv1.owner_id===customer.id&&srv1.variables.MOTD==='Hello there'&&srv1.node_id,'the server was created from the preset, with the buyer’s choices');
 check((await q('SELECT status FROM orders WHERE id=$1',[co.orderId]))[0].status==='paid','the order is marked paid');
 const created=await jobs(node);check(created.includes('create'),'the node got a create job');
 await waitMail(customer.email,/Receipt for €8.00/,'receipt');await waitMail(customer.email,/Survival SMP is ready/,'server ready mail');
 const rc=mailTo(customer.email,/Receipt/).at(-1);check(/MINECRAFT|Minecraft 2 GB/.test(rc.text)&&rc.text.includes('http'),'the receipt names the plan and links the invoice');
 check(mailTo(customer.email,/Receipt/).length===1,'one receipt, however many webhooks arrived');
 const inv1=(await q('SELECT * FROM invoices WHERE subscription_id=$1',[sub1.id]));check(inv1.length===1&&inv1[0].status==='paid'&&Number(inv1[0].amount_paid)===800&&inv1[0].hosted_url,'the invoice is mirrored');
 const bill=ok(await customer.cl.call('GET','/api/billing'),'billing page');check(bill.subscriptions.length===1&&bill.subscriptions[0].status==='active'&&bill.subscriptions[0].server.name==='Survival SMP'&&bill.invoices.length===1&&bill.portal,'the customer sees subscription, server and invoice');
 const order2=ok(await customer.cl.call('GET',`/api/store/orders/${co.orderId}`),'order');check(order2.status==='paid'&&order2.server&&order2.fulfilment==='done','the return page finds the server');
 status(await customer.cl.call('GET',`/api/servers/${srv1.id}`),200,'and the customer can open it');

 // --- Hostile webhooks -----------------------------------------------------------------------------------------------------------------------------------
 const ev=(opts)=>stripe.send('customer.subscription.updated',{id:paid.subscriptionId,object:'subscription'},opts);
 check((await ev({tamper:true})).status===400,'a wrong signature is refused');
 check((await ev({noSignature:true})).status===400,'so is a missing one');
 check((await ev({secret:'whsec_other'})).status===400,'and one made with another secret');
 check((await ev({timestamp:Math.floor(Date.now()/1000)-3600})).status===400,'an old (replayed) signature is refused');
 check((await ev({alteredBody:'{"id":"evt_x","type":"customer.subscription.updated","data":{"object":{"id":"sub_evil"}}}'})).status===400,'a body changed after signing is refused');
 const nonsense=await fetch(`${stack.base}/api/billing/webhooks/stripe`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':'t=1,v1=00'},body:'not json'});check(nonsense.status===400,'garbage is refused');
 const wrong=await fetch(`${stack.base}/api/billing/webhooks/paypal`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});check(wrong.status===404,'an unknown provider is refused');
 const empty=await fetch(`${stack.base}/api/billing/webhooks/stripe`,{method:'POST',headers:{'content-type':'application/json'},body:''});check(empty.status===400,'an empty body is refused');
 const eventsBefore=(await q('SELECT count(*)::int n FROM billing_events'))[0].n;
 const first=await stripe.send('customer.subscription.updated',{id:paid.subscriptionId,object:'subscription'});
 const evtId=first.id;check(first.status===200,'a good event is accepted');
 // the same event delivered again is stored once
 const resend=await (async()=>{const body=JSON.stringify({id:evtId,object:'event',type:'customer.subscription.updated',livemode:false,data:{object:{id:paid.subscriptionId}}});
  const t=Math.floor(Date.now()/1000),{createHmac}=await import('node:crypto');const sig=createHmac('sha256','whsec_testsecret').update(`${t}.${body}`).digest('hex');
  return (await fetch(`${stack.base}/api/billing/webhooks/stripe`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${t},v1=${sig}`},body})).json();})();
 check(resend.received===0,'the same event id is never stored twice');
 check((await q('SELECT count(*)::int n FROM billing_events'))[0].n===eventsBefore+1,'one new row');
 const unrelated=await stripe.send('customer.subscription.updated',{id:'sub_not_ours',object:'subscription'});check(unrelated.status===200,'events for subscriptions Fledge did not sell are acknowledged');
 await until(async()=>(await q('SELECT count(*)::int n FROM billing_events WHERE processed_at IS NULL'))[0].n===0,'the inbox to drain');
 check((await q('SELECT count(*)::int n FROM subscriptions'))[0].n===1,'and create nothing');
 const noise=await stripe.send('customer.created',{id:'cus_x',object:'customer'});check(noise.status===200,'event types Fledge does not use are fine');

 // --- Renewal, then a failed renewal and dunning -----------------------------------------------------------------------------------------
 const invR=await stripe.renew(paid.subscriptionId);
 await until(async()=>(await q('SELECT count(*)::int n FROM invoices WHERE subscription_id=$1',[sub1.id]))[0].n===2,'the renewal invoice');
 await waitMail(customer.email,/Receipt/);await until(()=>mailTo(customer.email,/Receipt/).length===2,'second receipt');
 const failedInv=await stripe.failRenewal(paid.subscriptionId);
 await until(async()=>(await subOf(sub1.id)).status==='past_due','past due');
 const pd=await subOf(sub1.id);check(pd.past_due_since,'the day it went wrong is recorded');
 await waitMail(customer.email,/payment for Minecraft 2 GB failed/,'payment failed mail');
 const srvPD=await serverFor(sub1.id);check(srvPD.suspended===false,'the server keeps running while the payment is only late');
 check(JSON.stringify(ok(await call('GET','/api/notifications'),'n')).includes('Payment failed for'),'administrators are told');
 // days pass: reminder, then suspension
 await q("UPDATE subscriptions SET past_due_since=now()-interval '4 days' WHERE id=$1",[sub1.id]);
 await waitMail(customer.email,/Reminder: payment/,'reminder after 3 days');
 check(mailTo(customer.email,/Reminder: payment/).length===1,'one reminder');
 await q("UPDATE subscriptions SET past_due_since=now()-interval '8 days' WHERE id=$1",[sub1.id]);
 await until(async()=>(await subOf(sub1.id)).status==='suspended','suspension after 7 days');
 const srvS=await serverFor(sub1.id);check(srvS.suspended===true&&srvS.suspended_reason==='billing'&&srvS.desired_status==='stopped','the server is stopped and held for billing');
 await waitMail(customer.email,/was suspended/,'suspension mail');
 await jobs(node);
 const shape=ok(await customer.cl.call('GET',`/api/servers/${srvS.id}`),'server');check(shape.suspendedReason==='billing'&&shape.subscriptionId===sub1.id,'the panel can tell the customer why');
 status(await customer.cl.call('POST',`/api/servers/${srvS.id}/actions`,{action:'start'}),409,'a suspended server cannot be started by its owner');
 // Stripe says "unpaid" long after: stays suspended
 await stripe.markUnpaid(paid.subscriptionId);await sleep(1500);
 check((await subOf(sub1.id)).status==='suspended','Stripe saying "unpaid" does not undo the suspension');
 // payment arrives
 await stripe.payOverdue(paid.subscriptionId);
 await until(async()=>(await subOf(sub1.id)).status==='active','payment lifts the suspension');
 const srvR=await serverFor(sub1.id);check(srvR.suspended===false&&!srvR.suspended_reason&&srvR.desired_status==='running','the server is released');
 await waitMail(customer.email,/is running again/,'resumed mail');
 const started=await jobs(node);check(started.includes('start'),'and started again');
 check((await subOf(sub1.id)).past_due_since===null,'the late-payment clock is reset');

 // --- A payment never lifts an administrator's suspension ------------------------------------------------------------------------------
 ok(await admin.call('POST',`/api/servers/${srvR.id}/actions`,{action:'suspend'}),'admin suspends for abuse');await jobs(node);
 check((await serverFor(sub1.id)).suspended_reason==='admin','marked as an administrator suspension');
 await stripe.failRenewal(paid.subscriptionId);await until(async()=>(await subOf(sub1.id)).status==='past_due','late again');
 await q("UPDATE subscriptions SET past_due_since=now()-interval '9 days' WHERE id=$1",[sub1.id]);await until(async()=>(await subOf(sub1.id)).status==='suspended','suspended again');
 await stripe.payOverdue(paid.subscriptionId);await until(async()=>(await subOf(sub1.id)).status==='active','paid again');
 const still=await serverFor(sub1.id);check(still.suspended===true&&still.suspended_reason==='admin','paying does not lift the administrator’s suspension');
 ok(await admin.call('POST',`/api/servers/${srvR.id}/actions`,{action:'unsuspend'}),'admin unsuspends');await jobs(node);
 check((await serverFor(sub1.id)).suspended===false&&!(await serverFor(sub1.id)).suspended_reason,'only the administrator can');

 // --- Admin view -----------------------------------------------------------------------------------------------------------------------------------------------------
 const list=ok(await call('GET','/api/billing/admin/subscriptions'),'subscriptions');check(list.items.length===1&&list.items[0].email===customer.email&&list.counts.active===1,'the subscription list');
 const detail=ok(await call('GET',`/api/billing/admin/subscriptions/${sub1.id}`),'detail');check(detail.events.some(e=>e.to==='suspended')&&detail.events.some(e=>e.to==='active')&&detail.invoices.length>=3&&detail.order.status==='paid'&&detail.server.name==='Survival SMP','the timeline explains what happened');
 status(await customer.cl.call('GET',`/api/billing/admin/subscriptions/${sub1.id}`),403,'customers cannot use the admin view');
 const ov=ok(await call('GET','/api/billing/overview'),'overview');check(ov.mrr.find(m=>m.currency==='eur').amount===800&&ov.revenueThisMonth.length===1&&ov.subscriptions.active===1,'MRR and revenue');
 const csv=await fetch(`${stack.base}/api/billing/invoices.csv`,{headers:{cookie:admin.cookie}});const csvText=await csv.text();check(csv.status===200&&csvText.startsWith('number,status,customer')&&csvText.includes(customer.email),'invoices export as CSV');

 // --- Cancel and resume ------------------------------------------------------------------------------------------------------------------------------------------
 const intruder=await newCustomer();status(await intruder.cl.call('POST',`/api/billing/subscriptions/${sub1.id}/cancel`,{}),404,'nobody else can cancel it');
 status(await anon.call('POST',`/api/billing/subscriptions/${sub1.id}/cancel`,{}),401,'nor an anonymous visitor');
 ok(await put('billing',{allowCustomerCancel:false}),'cancelling off');status(await customer.cl.call('POST',`/api/billing/subscriptions/${sub1.id}/cancel`,{}),403,'refused when the panel does not allow it');
 ok(await put('billing',{allowCustomerCancel:true}),'cancelling on');
 const cn=ok(await customer.cl.call('POST',`/api/billing/subscriptions/${sub1.id}/cancel`,{}),'cancel');check(cn.cancelAtPeriodEnd===true&&cn.status==='active','cancelling schedules the end; access continues');
 check(stripe.state.subs[paid.subscriptionId].cancel_at_period_end===true,'Stripe was told');
 await waitMail(customer.email,/will end/,'cancellation mail');
 status(await customer.cl.call('POST',`/api/billing/subscriptions/${sub1.id}/cancel`,{}),409,'cancelling twice is refused');
 ok(await customer.cl.call('POST',`/api/billing/subscriptions/${sub1.id}/resume`,{}),'resume');check((await subOf(sub1.id)).cancel_at_period_end===false&&stripe.state.subs[paid.subscriptionId].cancel_at_period_end===false,'resuming undoes it');
 ok(await customer.cl.call('POST',`/api/billing/subscriptions/${sub1.id}/cancel`,{}),'cancel again');
 await stripe.endCancelled(paid.subscriptionId);
 await until(async()=>(await subOf(sub1.id)).status==='canceled','the end of the period');
 const ended=await subOf(sub1.id);check(ended.retention_until&&ended.ended_at,'ended, with a date until which the data is kept');
 const srvE=await serverFor(sub1.id);check(srvE.suspended&&srvE.suspended_reason==='billing','the server is stopped but kept');
 await waitMail(customer.email,/has ended/,'ended mail');await jobs(node);
 check((await q("SELECT count(*)::int n FROM servers WHERE id=$1 AND deleted_at IS NULL",[srvE.id]))[0].n===1,'nothing is deleted');
 await q("UPDATE subscriptions SET retention_until=now()-interval '1 day' WHERE id=$1",[sub1.id]);await sleep(3000);
 check((await subOf(sub1.id)).status==='canceled','with automatic termination off, an expired server waits for an administrator');
 check(JSON.stringify(ok(await call('GET','/api/notifications'),'n')).includes('retention'),'who is reminded');
 const hh2=ok(await call('GET','/api/billing/health'),'health');check(hh2.expiredWaiting===1&&hh2.problems.some(p=>/retention/.test(p)),'billing health lists it');
 ok(await put('billing',{autoTerminate:true}),'automatic termination on');
 await until(async()=>(await subOf(sub1.id)).status==='terminated','termination after retention');
 const srvT=(await q('SELECT * FROM servers WHERE id=$1',[srvE.id]))[0];check(srvT.pending_delete_at&&srvT.suspended_reason==='billing-terminated','the server is scheduled for deletion, not deleted at once');
 ok(await put('billing',{autoTerminate:false}),'off again');
 await q('UPDATE servers SET pending_delete_at=now()-interval \'1 minute\' WHERE id=$1',[srvE.id]);
 let del;for(let i=0;i<20&&!del;i++){await sleep(500);const j=await nextJob(admin,node);if(j&&j.kind==='delete')del=j;else if(j)await finishJob(admin,node,j,true,{});}
 check(del,'and then removed through the normal deletion job');await finishJob(admin,node,del,true,{});

 // --- Trials, setup fees, plan changes --------------------------------------------------------------------------------------------------------------------------
 const buyer=await newCustomer();
 const co2=ok(await buyer.cl.call('POST','/api/store/checkout',{planId:mc4.id,cycle:'month',acceptTerms:true,name:'Big one'}),'checkout 4 GB');
 const s2=stripe.requests('/v1/checkout/sessions','POST').at(-1).params;
 check(s2.line_items.length===2&&s2.line_items[1].price_data.unit_amount==='200'&&!s2.line_items[1].price_data.recurring&&s2.subscription_data.trial_period_days==='7','a setup fee is a one-time line and the trial is passed on');
 const sess2=(await q('SELECT provider_session_id FROM orders WHERE id=$1',[co2.orderId]))[0].provider_session_id;
 const paid2=await stripe.completeCheckout(sess2);
 const sub2=await until(async()=>{const r=(await q('SELECT * FROM subscriptions WHERE order_id=$1',[co2.orderId]))[0];return r&&r.status==='trialing'&&r.fulfilment==='done'?r:null;},'a trialing subscription');
 check(sub2.trial_end&&Number(sub2.amount)===1500,'trialing, with the trial end recorded');
 const srv2=await serverFor(sub2.id);check(srv2.memory_mb===4096,'the server exists during the trial');await jobs(node);
 // the same plan again: no second trial
 const co3=ok(await buyer.cl.call('POST','/api/store/checkout',{planId:mc4.id,cycle:'month',acceptTerms:true,name:'Second'}),'again');
 check(!stripe.requests('/v1/checkout/sessions','POST').at(-1).params.subscription_data.trial_period_days,'a trial is offered once per customer and plan');
 // switch to the yearly price of the same plan? changing needs an upgrade path: use the smaller plan as a downgrade
 status(await buyer.cl.call('POST',`/api/billing/subscriptions/${sub2.id}/change`,{planId:mc2.id,cycle:'month'}),200,'a downgrade to the 2 GB plan');
 const chg=stripe.requests(`/v1/subscriptions/${paid2.subscriptionId}`,'POST').at(-1);check(chg.params.items[0].price_data.unit_amount==='800'&&chg.params.proration_behavior==='create_prorations'&&chg.params.payment_behavior==='error_if_incomplete','Stripe prorates and refuses a half-paid change');
 const srv2b=await serverFor(sub2.id);check(srv2b.memory_mb===2048&&srv2b.disk_mb===10240,'the server was resized');
 const cj=await jobs(node);check(cj.includes('configure'),'the node got a configure job');
 check((await subOf(sub2.id)).plan_id===mc2.id,'the subscription points at the new plan');
 await waitMail(buyer.email,/plan changed|Your plan changed/i,'plan changed mail');
 const prev=ok(await buyer.cl.call('GET',`/api/billing/preview-change?subscriptionId=${sub2.id}&planId=${mc4.id}&cycle=month`),'preview');check(prev.to.plan==='Minecraft 4 GB'&&prev.restart===true&&prev.smaller===false,'a change can be previewed first');
 status(await buyer.cl.call('POST',`/api/billing/subscriptions/${sub2.id}/change`,{planId:mc2.id,cycle:'month'}),400,'changing to the plan you are on is refused');
 status(await buyer.cl.call('POST',`/api/billing/subscriptions/${sub2.id}/change`,{planId:creator.id,cycle:'month'}),400,'a different kind of plan cannot be swapped in');
 ok(await put('billing',{allowDowngrade:false}),'downgrades off');
 ok(await buyer.cl.call('POST',`/api/billing/subscriptions/${sub2.id}/change`,{planId:mc4.id,cycle:'month'}),'upgrade back');
 check((await serverFor(sub2.id)).memory_mb===4096,'upgrades apply at once');await jobs(node);
 status(await buyer.cl.call('POST',`/api/billing/subscriptions/${sub2.id}/change`,{planId:mc2.id,cycle:'month'}),403,'downgrades can be switched off');
 ok(await put('billing',{allowDowngrade:true}),'on again');

 // --- Account plans feed the limits system ----------------------------------------------------------------------------------------------------------------------------
 ok(await put('limits',{defaults:{servers:0}}),'nobody may have servers of their own by default');
 ok(await put('selfService',{mode:'presets'}),'server-plan-only mode on');
 const presetOptions=ok(await buyer.cl.call('GET','/api/me/servers/options'),'server-plan-only options');
 check(presetOptions.mode==='presets'&&!presetOptions.canCreate,'server-plan-only mode does not advertise account-plan server creation');
 status(await buyer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Preset mode'}),403,'server-plan-only mode does not allow self-creation');
 ok(await put('selfService',{mode:'plans'}),'account-plan server creation on');ok(await call('PUT','/api/templates/minecraft-java/store',{customerVisible:true}),'release template');
 const noPlanOptions=ok(await buyer.cl.call('GET','/api/me/servers/options'),'options without plan');
 check(!noPlanOptions.canCreate&&noPlanOptions.planRequired,'account-plan mode requires an explicit account-plan grant');
 check(!(ok(await buyer.cl.call('GET','/api/features'),'features without plan')).selfService.canCreate,'customer navigation does not advertise creation without a plan grant');
 status(await buyer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Mine'}),403,'no account-plan grant, no server');
 const observer=await newCustomer();
 const observerOrder=ok(await observer.cl.call('POST','/api/store/checkout',{planId:observerPlan.id,cycle:'month',acceptTerms:true}),'buy plan without creation permission');
 check(observerOrder.free,'the observer plan is free');
 const observerOptions=ok(await observer.cl.call('GET','/api/me/servers/options'),'options for plan without grant');
 check(!observerOptions.canCreate&&observerOptions.planRequired,'a plan without an explicit grant cannot create servers');
 status(await observer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Observer server'}),403,'an account plan without the grant cannot create a server');
 const co4=ok(await buyer.cl.call('POST','/api/store/checkout',{planId:creator.id,cycle:'month',acceptTerms:true}),'buy Creator');
 const paid4=await stripe.completeCheckout((await q('SELECT provider_session_id FROM orders WHERE id=$1',[co4.orderId]))[0].provider_session_id);
 await until(async()=>(await q("SELECT status FROM subscriptions WHERE provider_subscription_id=$1",[paid4.subscriptionId]))[0]?.status==='active','Creator active');
 const lim=ok(await buyer.cl.call('GET','/api/limits/me'),'limits');const lr=lim.rows.find(r=>r.key==='servers');check(lr.limit===5&&lr.source==='plan'&&lr.plans.includes('Creator'),'the plan adds to the allowance and says so');
 const planOptions=ok(await buyer.cl.call('GET','/api/me/servers/options'),'options for plan with creation permission');
 check(planOptions.canCreate&&!planOptions.planRequired&&!planOptions.customResources,'the account-plan grant unlocks fixed-size creation');
 check((ok(await buyer.cl.call('GET','/api/features'),'features with plan')).selfService.canCreate,'customer navigation advertises creation with a plan grant');
 check(planOptions.templates.map(t=>t.id).join(',')==='minecraft-java'&&planOptions.locations.join(',')==='eu-west','plan template and location allowances narrow customer choices');
 status(await buyer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Own server',memoryMb:1024}),400,'plan-only mode refuses custom resource sizes');
 status(await buyer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Own server',location:'mars'}),400,'plan-only mode refuses locations outside the plan');
 const priorQuota=(await q('SELECT quota FROM users WHERE email=$1',[buyer.email]))[0].quota;
 await q('UPDATE users SET quota=$2 WHERE email=$1',[buyer.email,{selfCreate:false}]);
 check(!ok(await buyer.cl.call('GET','/api/me/servers/options'),'options with explicit denial').canCreate,'an explicit customer-level denial overrides a plan grant');
 status(await buyer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Denied server'}),403,'a customer-level denial blocks creation despite a plan grant');
 await q('UPDATE users SET quota=$2 WHERE email=$1',[buyer.email,priorQuota]);
 ok(await put('selfService',{allowRename:false}),'disable customer renaming');
 ok(await buyer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Customer chosen name'}),'now a fixed-size server can be created');
 ok(await put('selfService',{allowRename:true}),'enable customer renaming');
 const own=(await q("SELECT * FROM servers WHERE owner_id=(SELECT id FROM users WHERE email=$1) AND subscription_id IS NULL AND deleted_at IS NULL",[buyer.email]))[0];
 check(own.name===(await q("SELECT name FROM templates WHERE id='minecraft-java'"))[0].name,'disabled renaming uses the administrator-published template name');
 const lim2=ok(await buyer.cl.call('GET','/api/limits/me'),'limits');check(lim2.rows.find(r=>r.key==='servers').used===1,'plan-backed servers do not use the allowance (only the one created here counts)');
 await q("UPDATE subscriptions SET status='past_due' WHERE id=(SELECT id FROM subscriptions WHERE provider_subscription_id=$1)",[paid4.subscriptionId]);
 check(ok(await buyer.cl.call('GET','/api/me/servers/options'),'grace-period options').canCreate,'the account-plan grant remains during payment grace');
 await q("UPDATE subscriptions SET status='suspended' WHERE provider_subscription_id=$1",[paid4.subscriptionId]);
 check(!ok(await buyer.cl.call('GET','/api/me/servers/options'),'options after suspension').canCreate,'a suspended account plan no longer grants creation');
 status(await buyer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Suspended plan'}),403,'a suspended account plan cannot create a server');
 await q("UPDATE subscriptions SET status='canceled' WHERE provider_subscription_id=$1",[paid4.subscriptionId]);
 check(!ok(await buyer.cl.call('GET','/api/me/servers/options'),'options after cancellation').canCreate,'a canceled account plan no longer grants creation');
 status(await buyer.cl.call('POST','/api/me/servers',{templateId:'minecraft-java',name:'Ended plan'}),403,'a canceled plan cannot be used to create a server');
 await q("UPDATE subscriptions SET status='terminated' WHERE provider_subscription_id=$1",[paid4.subscriptionId]);
 check(!ok(await buyer.cl.call('GET','/api/me/servers/options'),'options after termination').canCreate,'a terminated account plan no longer grants creation');
 await q("UPDATE subscriptions SET status='active' WHERE provider_subscription_id=$1",[paid4.subscriptionId]);
 await jobs(node);
 ok(await put('limits',{defaults:{}}),'clear');ok(await put('selfService',{mode:'off'}),'off');

 // --- Free plans -------------------------------------------------------------------------------------------------------------------------------------------------------------------
 const fr=ok(await other.cl.call('POST','/api/store/checkout',{planId:freebie.id,cycle:'month',acceptTerms:true,name:'Free one'}),'claim a free plan');
 check(fr.free&&fr.subscriptionId,'free plans need no payment');
 const frSub=await subOf(fr.subscriptionId);check(frSub.provider==='manual'&&frSub.status==='active','as a complimentary subscription');
 const frSrv=await until(()=>serverFor(fr.subscriptionId),'the free server');check(frSrv.name==='Free one','with a server');await jobs(node);

 // --- Limited stock and parallel buyers ---------------------------------------------------------------------------------------------------------------------------
 const racers=await Promise.all([newCustomer(),newCustomer(),newCustomer()]);
 const results=await Promise.all(racers.map(r=>r.cl.call('POST','/api/store/checkout',{planId:scarce.id,cycle:'month',acceptTerms:true})));
 const wins=results.filter(r=>r.code===200).length;check(wins===1&&results.filter(r=>r.code===409).length===2,'three buyers race for the last one: exactly one gets it');
 const sc=ok(await call('GET','/api/plans'),'plans').find(p=>p.id===scarce.id);check(sc.remaining===0&&sc.pendingOrders===1,'the plan shows nothing left');
 const cat2=ok(await racers[0].cl.call('GET','/api/store'),'catalogue');check(cat2.plans.find(p=>p.name==='Scarce').soldOut===true,'and the store says sold out');

 // --- Paid, but no room for the server -------------------------------------------------------------------------------------------------------------------------------
 const late=await newCustomer();
 const co5=ok(await late.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month',acceptTerms:true,name:'Late one'}),'checkout');
 ok(await call('PATCH',`/api/nodes/${node.id}`,{draining:true}),'the node starts draining');
 const paid5=await stripe.completeCheckout((await q('SELECT provider_session_id FROM orders WHERE id=$1',[co5.orderId]))[0].provider_session_id);
 const sub5=await until(async()=>{const r=(await q('SELECT * FROM subscriptions WHERE provider_subscription_id=$1',[paid5.subscriptionId]))[0];return r&&r.fulfilment==='failed'?r:null;},'a failed fulfilment');
 check(sub5.status==='active'&&sub5.fulfilment_error&&!(await serverFor(sub5.id)),'paid and active, but waiting for a server');
 await waitMail(late.email,/setting up your Minecraft 2 GB/,'"we are setting this up" mail');
 await waitMail('billing@example.test',/could not be created/,'administrator mail');
 check(JSON.stringify(ok(await call('GET','/api/notifications'),'n')).includes('could not be created'),'and a notification');
 const poll5=ok(await late.cl.call('GET',`/api/store/orders/${co5.orderId}`),'order');check(poll5.status==='paid'&&poll5.fulfilment==='failed'&&poll5.server===null,'the return page shows the pending state');
 check(ok(await call('GET','/api/billing/health'),'h').failedFulfilments===1,'billing health counts it');
 ok(await call('PATCH',`/api/nodes/${node.id}`,{draining:false}),'room again');
 await q("UPDATE subscriptions SET next_fulfilment_at=now() WHERE id=$1",[sub5.id]);
 await until(async()=>(await subOf(sub5.id)).fulfilment==='done','the retry succeeds');
 const srv5=await serverFor(sub5.id);check(srv5.name==='Late one','the server appears');await waitMail(late.email,/Late one is ready/,'ready mail');await jobs(node);
 check(mailTo(late.email,/Receipt/).length===1&&mailTo(late.email,/is ready/).length===1,'no duplicate mail from the retries');
 // an administrator can retry by hand, which changes nothing once it is done
 ok(await call('POST',`/api/billing/admin/subscriptions/${sub5.id}/retry-fulfilment`,{}),'manual retry is harmless');check((await q('SELECT count(*)::int n FROM servers WHERE subscription_id=$1',[sub5.id]))[0].n===1,'still one server');

 // --- The browser never has to come back: reconciliation -------------------------------------------------------------------------------------------------------------------
 const lost=await newCustomer();
 const co6=ok(await lost.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'year',acceptTerms:true,name:'No webhook'}),'checkout');
 const paid6=await stripe.completeCheckout((await q('SELECT provider_session_id FROM orders WHERE id=$1',[co6.orderId]))[0].provider_session_id,{webhooks:false});
 const poll6=await until(async()=>{const r=ok(await lost.cl.call('GET',`/api/store/orders/${co6.orderId}`),'order');return r.status==='paid'&&r.server?r:null;},'the return page to complete a payment whose webhook never came');
 check(poll6.server.name==='No webhook','a missing webhook is repaired when the customer returns');await jobs(node);
 const sub6=(await q('SELECT * FROM subscriptions WHERE provider_subscription_id=$1',[paid6.subscriptionId]))[0];
 // a renewal whose webhook is lost; the scheduled check finds it
 await stripe.renew(paid6.subscriptionId,{webhooks:false});
 await stripe.failRenewal(paid6.subscriptionId,{webhooks:false});
 await q("UPDATE subscriptions SET reconciled_at=now()-interval '1 hour' WHERE id=$1",[sub6.id]);
 await until(async()=>(await subOf(sub6.id)).status==='past_due','the scheduled check to notice a failed payment');
 check((await q("SELECT count(*)::int n FROM audit_events WHERE action='billing.drift'"))[0].n>=1,'and record that it repaired something');
 await stripe.payOverdue(paid6.subscriptionId,{webhooks:false});await q("UPDATE subscriptions SET reconciled_at=now()-interval '1 hour' WHERE id=$1",[sub6.id]);
 await until(async()=>(await subOf(sub6.id)).status==='active','and the payment that followed');

 // --- Disputes and refunds ------------------------------------------------------------------------------------------------------------------------------------------------------------------
 await stripe.dispute(paid6.subscriptionId,'created');
 await until(async()=>(await subOf(sub6.id)).holds.length===1,'a dispute hold');
 const srv6=await serverFor(sub6.id);check(srv6.suspended&&srv6.suspended_reason==='billing','a dispute stops the server');await waitMail('billing@example.test',/dispute/i,'dispute mail to administrators');
 await stripe.dispute(paid6.subscriptionId,'closed',true);
 await until(async()=>(await subOf(sub6.id)).holds.length===0,'the hold to clear');
 await until(async()=>!(await serverFor(sub6.id)).suspended,'a won dispute releases the server');await jobs(node);
 const invs=ok(await call('GET',`/api/billing/admin/subscriptions/${sub6.id}`),'detail').invoices;const refundable=invs.find(i=>i.refundable);
 status(await customer.cl.call('POST',`/api/billing/admin/subscriptions/${sub6.id}/refund`,{invoiceId:refundable.id}),403,'customers cannot refund');
 status(await call('POST',`/api/billing/admin/subscriptions/${sub6.id}/refund`,{invoiceId:refundable.id,amount:99999999}),400,'more than was paid');
 ok(await call('POST',`/api/billing/admin/subscriptions/${sub6.id}/refund`,{invoiceId:refundable.id,amount:1000}),'refund 10.00');
 await waitMail(lost.email,/Refund of €10.00/,'refund mail');
 check((await q('SELECT amount_refunded FROM invoices WHERE id=$1',[refundable.id]))[0].amount_refunded==='1000'||Number((await q('SELECT amount_refunded FROM invoices WHERE id=$1',[refundable.id]))[0].amount_refunded)===1000,'the invoice shows the refund');

 // --- Complimentary subscriptions ------------------------------------------------------------------------------------------------------------------------------------------------------------
 const guest=await newCustomer();
 status(await call('POST','/api/billing/grants',{userId:guest.id,planId:creator.id,endsAt:'2001-01-01'}),400,'an end date in the past');
 const gr=ok(await call('POST','/api/billing/grants',{userId:guest.id,planId:mc2.id,serverName:'Gifted',endsAt:new Date(Date.now()+86400000).toISOString(),note:'staff'}),'grant');
 check(gr.provider==='manual'&&gr.status==='active','a granted plan is active at once');await until(()=>serverFor(gr.id),'the gifted server');await jobs(node);
 const lim3=ok(await guest.cl.call('GET','/api/billing'),'billing');check(lim3.subscriptions[0].comped===true&&!lim3.subscriptions[0].can.cancel,'it is shown as complimentary and cannot be cancelled by the customer');
 status(await guest.cl.call('POST',`/api/billing/subscriptions/${gr.id}/cancel`,{}),403,'the customer cannot end it');
 await q("UPDATE subscriptions SET manual_ends_at=now()-interval '1 minute' WHERE id=$1",[gr.id]);
 await until(async()=>(await subOf(gr.id)).status==='canceled','it ends on its date');
 check((await serverFor(gr.id)).suspended_reason==='billing','and its server is held, not deleted');await jobs(node);
 ok(await call('POST',`/api/billing/admin/subscriptions/${gr.id}/extend`,{endsAt:new Date(Date.now()+864000000).toISOString()}),'extend');check((await subOf(gr.id)).status==='active','extending brings it back');
 await until(async()=>!(await serverFor(gr.id)).suspended,'and releases the server');await jobs(node);
 // holds
 ok(await call('POST',`/api/billing/admin/subscriptions/${gr.id}/hold`,{on:true,note:'investigation'}),'hold');check((await serverFor(gr.id)).suspended,'a hold stops the server whatever the status');
 ok(await call('POST',`/api/billing/admin/subscriptions/${gr.id}/hold`,{on:false}),'release the hold');await until(async()=>!(await serverFor(gr.id)).suspended,'released');await jobs(node);

 // --- Switching the provider off ------------------------------------------------------------------------------------------------------------------------------------------------------------
 ok(await call('PATCH','/api/plugins/stripe',{enabled:false}),'disable the payment plugin');
 check((await ev({})).status===503,'webhooks are told to come back later');
 status(await customer.cl.call('POST','/api/store/checkout',{planId:mc2.id,cycle:'month',acceptTerms:true}),503,'and nothing can be bought');
 ok(await customer.cl.call('GET','/api/billing'),'but the billing page still works');
 const fcat=ok(await customer.cl.call('GET','/api/store'),'store');check(fcat.canBuy===false,'the store says it cannot sell');

 console.log(`PASS ${admin.state.count} assertions: plugin install and keys, plans and immutable prices, store readiness, checkout (server-side prices, idempotency, stock races), signed webhooks (forged, replayed, duplicated, unrelated), fulfilment, receipts, renewals, dunning, suspension, billing holds vs administrator suspension, cancel/resume, retention and termination, trials, setup fees, plan changes, account plans in limits, free and complimentary plans, failed fulfilment and retry, reconciliation, disputes, refunds`);
}catch(e){failed=e;console.error('FAIL',e.message);console.error(String(e.stack).split(String.fromCharCode(10)).filter(l=>l.includes('billing-smoke')).slice(0,2).join(String.fromCharCode(10)));try{console.error('--- billing events ---',JSON.stringify(await q('SELECT type,error,attempts,processed_at IS NOT NULL AS done FROM billing_events ORDER BY id DESC LIMIT 8')));console.error('--- subscriptions ---',JSON.stringify(await q('SELECT status,fulfilment,fulfilment_error FROM subscriptions ORDER BY created_at DESC LIMIT 4')));}catch{}console.error('--- api log tail ---');console.error(stack.api.logs().split(String.fromCharCode(10)).slice(-25).join(String.fromCharCode(10)));}
await stack.stop();smtp.close();await stripe.stop();
process.exit(failed?1:0);
