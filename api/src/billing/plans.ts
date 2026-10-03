import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,txt,asId,audit} from '../core.js';
import {settings,imageAllowed} from '../settings.js';
import {validateLimitSet,toStorage,fromStorage} from '../rookery-settings.js';
import {effectiveDefs,checkValue} from '../templates.js';
import {isInterval,validCurrency,INTERVALS,perMonth,savingsPercent,formatMoney,type Interval} from '../money.js';

// Plans: the things that can be given or sold. A server plan carries a preset (what one
// subscription provisions), an account plan carries an allowance added to the customer's
// limits. Prices are rows of their own and are never edited in place, so what a customer
// agreed to stays what it was.

const SLUG=/^[a-z0-9][a-z0-9-]{1,47}$/;
const CEIL={memoryMb:262144,cpuPercent:6400,diskMb:4194304};
export const slugify=(s:string)=>s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48);

export type PresetInput={templateId:string;memoryMb:number;cpuPercent:number;diskMb:number;locations:string[];allowLocationChoice:boolean;allowNameChoice:boolean;variables:Record<string,string>;editableVariables:string[]};

async function validatePreset(raw:any):Promise<PresetInput>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail(400,'A server plan needs a preset');
 const templateId=txt(raw.templateId,64);
 const t=(await pool.query('SELECT id,image,env,memory_mb,cpu_percent,disk_mb,editable_variables,variables FROM templates WHERE id=$1',[templateId])).rows[0];
 if(!t)fail(400,'That template does not exist');
 if(!(await imageAllowed(t.image)))fail(400,'That template’s image is not on the allowed list (Settings, Nodes)');
 const num=(v:any,def:number,max:number,label:string)=>{if(v===undefined||v===null||v==='')return def;const n=Number(v);if(!Number.isInteger(n)||n<1||n>max)fail(400,`${label} must be a whole number from 1 to ${max}`);return n;};
 const memoryMb=num(raw.memoryMb,t.memory_mb,CEIL.memoryMb,'Memory'),cpuPercent=num(raw.cpuPercent,t.cpu_percent,CEIL.cpuPercent,'CPU'),diskMb=num(raw.diskMb,t.disk_mb,CEIL.diskMb,'Disk');
 if(memoryMb<256)fail(400,'Memory must be at least 256 MB');
 const locations=Array.isArray(raw.locations)?[...new Set(raw.locations.map((x:any)=>String(x).trim()).filter(Boolean))].slice(0,50) as string[]:[];
 const variables:Record<string,string>={};
 if(raw.variables!==undefined){
  if(!raw.variables||typeof raw.variables!=='object'||Array.isArray(raw.variables))fail(400,'Variables must be an object');
  for(const [k,v] of Object.entries(raw.variables as Record<string,unknown>)){
   if(!/^[A-Z_][A-Z0-9_]*$/.test(k))fail(400,`“${k.slice(0,40)}” is not a valid variable name`);
   if(typeof v!=='string'||v.length>4096)return fail(400,`${k} must be text`);
   variables[k]=v;
  }
 }
 // Settings the buyer may choose themselves; they must be ones the template lets a person edit.
 const defs=effectiveDefs(t).filter((d:any)=>d.userEditable);
 const editable=Array.isArray(raw.editableVariables)?[...new Set((raw.editableVariables as unknown[]).map(String))].filter(k=>defs.some((d:any)=>d.key===k)):[];
 return {templateId,memoryMb,cpuPercent,diskMb,locations,allowLocationChoice:raw.allowLocationChoice!==false,allowNameChoice:raw.allowNameChoice!==false,variables,editableVariables:editable};
}

const text=(v:any,name:string,max:number,required=false)=>{
 if(v===undefined||v===null||v===''){if(required)fail(400,`${name} is required`);return '';}
 if(typeof v!=='string'||v.length>max)fail(400,`${name} must be text up to ${max} characters`);
 return v.trim();
};

export async function validatePlan(b:any,existing?:any){
 if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'Expected an object');
 const name=text(b.name??existing?.name,'Name',80,true);
 const kind=existing?existing.kind:(['server','account'].includes(b.kind)?b.kind:fail(400,'kind must be server or account'));
 if(existing&&b.kind&&b.kind!==existing.kind)fail(400,'The kind of a plan cannot be changed; create a new plan instead');
 const slug=text(b.slug??existing?.slug??slugify(name),'Address name',48,true);
 if(!SLUG.test(slug))fail(400,'The address name uses lowercase letters, numbers and hyphens (2 to 48 characters)');
 const visibility=['public','hidden','private'].includes(b.visibility)?b.visibility:(existing?.visibility??'public');
 const features=Array.isArray(b.features)?b.features.map((f:any)=>text(f,'Feature',120)).filter(Boolean).slice(0,12):(existing?.features??[]);
 const stock=b.stock===undefined?(existing?.stock??null):b.stock===null||b.stock===''?null:(Number.isInteger(Number(b.stock))&&Number(b.stock)>=0&&Number(b.stock)<=1e6?Number(b.stock):fail(400,'Stock must be a whole number, or empty for no limit'));
 const perCustomerMax=b.perCustomerMax===undefined?(existing?.per_customer_max??(kind==='account'?1:5)):(Number.isInteger(Number(b.perCustomerMax))&&Number(b.perCustomerMax)>=1&&Number(b.perCustomerMax)<=1000?Number(b.perCustomerMax):fail(400,'Per customer must be 1 to 1000'));
 const retention=b.retentionDays===undefined?(existing?.retention_days??null):b.retentionDays===null||b.retentionDays===''?null:(Number.isInteger(Number(b.retentionDays))&&Number(b.retentionDays)>=0&&Number(b.retentionDays)<=3650?Number(b.retentionDays):fail(400,'Retention must be 0 to 3650 days'));
 const o=(b.options&&typeof b.options==='object'&&!Array.isArray(b.options)?b.options:existing?.options)||{};
 const options={highlight:!!o.highlight,badge:text(o.badge,'Badge',24),free:!!o.free,note:text(o.note,'Note',300)};
 const preset=kind==='server'?await validatePreset(b.preset??existing?.preset):{};
 const limits=kind==='account'?toStorage(validateLimitSet(b.limits??fromStorage(existing?.limits),'limits')):{};
 return {name,kind,slug,description:text(b.description??existing?.description,'Description',600),visibility,features,stock,perCustomerMax,trialOnce:b.trialOnce===undefined?(existing?.trial_once??true):!!b.trialOnce,retention,options,preset,limits,active:b.active===undefined?(existing?.active??true):!!b.active,sortOrder:Number.isInteger(b.sortOrder)?b.sortOrder:(existing?.sort_order??0)};
}

type PriceIn={cycle:Interval;amount:number;currency:string;trialDays:number;setupFee:number};
export function validatePrices(raw:any,allowedCurrencies:string[]):PriceIn[]{
 if(!Array.isArray(raw)||raw.length>16)fail(400,'prices must be a list of at most 16 entries');
 const out:PriceIn[]=[];
 for(const p of raw){
  if(!p||typeof p!=='object')fail(400,'Each price needs a cycle, an amount and a currency');
  if(!isInterval(p.cycle))fail(400,'cycle must be month, quarter, semiannual or year');
  const currency=String(p.currency||'').toLowerCase();
  if(!validCurrency(currency))fail(400,`“${String(p.currency).slice(0,10)}” is not a currency`);
  if(allowedCurrencies.length&&!allowedCurrencies.includes(currency))fail(400,`${currency.toUpperCase()} is not enabled in Settings, Billing`);
  const amount=Number(p.amount),setup=Number(p.setupFee??0),trial=Number(p.trialDays??0);
  if(!Number.isSafeInteger(amount)||amount<0||amount>1e10)fail(400,'amount must be a whole number of the smallest currency unit (cents)');
  if(!Number.isSafeInteger(setup)||setup<0||setup>1e10)fail(400,'setupFee must be a whole number of the smallest currency unit');
  if(!Number.isInteger(trial)||trial<0||trial>365)fail(400,'trialDays must be 0 to 365');
  if(amount>0&&amount<50)fail(400,'The smallest amount most payment providers accept is 0.50');
  if(out.some(x=>x.cycle===p.cycle&&x.currency===currency))fail(400,`${p.cycle} in ${currency.toUpperCase()} is listed twice`);
  out.push({cycle:p.cycle,amount,currency,trialDays:trial,setupFee:setup});
 }
 return out;
}

/** Replaces the plan's current prices. Unchanged prices are kept; changed ones become new rows (old rows stay for existing subscribers). */
export async function savePrices(planId:string,prices:PriceIn[]){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const current=(await c.query('SELECT * FROM plan_prices WHERE plan_id=$1 AND active FOR UPDATE',[planId])).rows;
  for(const old of current){
   const keep=prices.find(p=>p.cycle===old.cycle&&p.currency===old.currency&&p.amount===Number(old.amount)&&p.trialDays===old.trial_days&&p.setupFee===Number(old.setup_fee));
   if(!keep)await c.query('UPDATE plan_prices SET active=false WHERE id=$1',[old.id]);
  }
  for(const p of prices){
   const exists=current.some(old=>p.cycle===old.cycle&&p.currency===old.currency&&p.amount===Number(old.amount)&&p.trialDays===old.trial_days&&p.setupFee===Number(old.setup_fee));
   if(!exists)await c.query('INSERT INTO plan_prices(plan_id,cycle,amount,currency,trial_days,setup_fee) VALUES($1,$2,$3,$4,$5,$6)',[planId,p.cycle,p.amount,p.currency,p.trialDays,p.setupFee]);
  }
  await c.query('UPDATE plans SET updated_at=now() WHERE id=$1',[planId]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}

export function planShape(p:any,prices:any[],counts?:{active:number;pending:number}){
 return {id:p.id,slug:p.slug,name:p.name,description:p.description,kind:p.kind,visibility:p.visibility,active:p.active,sortOrder:p.sort_order,features:p.features,preset:p.preset,limits:fromStorage(p.limits),options:p.options,
  stock:p.stock,perCustomerMax:p.per_customer_max,trialOnce:p.trial_once,retentionDays:p.retention_days,archivedAt:p.archived_at,createdAt:p.created_at,updatedAt:p.updated_at,
  prices:prices.filter(x=>x.active).map(x=>({id:x.id,cycle:x.cycle,amount:Number(x.amount),currency:x.currency,trialDays:x.trial_days,setupFee:Number(x.setup_fee)})),
  ...(counts?{subscribers:counts.active,pendingOrders:counts.pending,remaining:p.stock===null?null:Math.max(0,p.stock-counts.active-counts.pending)}:{})};
}

async function countsFor(ids:string[]){
 const out=new Map<string,{active:number;pending:number}>();
 if(!ids.length)return out;
 for(const r of (await pool.query("SELECT plan_id,count(*)::int n FROM subscriptions WHERE plan_id=ANY($1::uuid[]) AND status NOT IN ('canceled','terminated') GROUP BY plan_id",[ids])).rows)out.set(r.plan_id,{active:r.n,pending:0});
 for(const r of (await pool.query("SELECT plan_id,count(*)::int n FROM orders WHERE plan_id=ANY($1::uuid[]) AND status IN ('created','pending') AND expires_at>now() GROUP BY plan_id",[ids])).rows){const c=out.get(r.plan_id)||{active:0,pending:0};c.pending=r.n;out.set(r.plan_id,c);}
 return out;
}

/** How many more can be sold, and whether a server for this preset would fit on a node right now. */
export async function availability(plan:any){
 const [c]=[ (await countsFor([plan.id])).get(plan.id)||{active:0,pending:0} ];
 const remaining=plan.stock===null?null:Math.max(0,plan.stock-c.active-c.pending);
 let capacity=true;
 if(plan.kind==='server'){
  const p=plan.preset||{};
  const locs=Array.isArray(p.locations)&&p.locations.length?p.locations:null;
  const n=(await pool.query(`SELECT count(*)::int n FROM (SELECT n.id FROM nodes n LEFT JOIN servers s ON s.node_id=n.id AND s.deleted_at IS NULL
    WHERE n.status='connected' AND NOT n.draining AND n.deleted_at IS NULL AND ($1::text[] IS NULL OR n.location=ANY($1))
    GROUP BY n.id HAVING coalesce(sum(s.memory_mb),0)+$2<=max(n.memory_mb)-max(n.headroom_mb) AND coalesce(sum(s.cpu_percent),0)+$3<=max(n.cpu_percent) AND coalesce(sum(s.disk_mb),0)+$4<=max(n.disk_mb)) x`,
   [locs,p.memoryMb||0,p.cpuPercent||0,p.diskMb||0])).rows[0].n;
  capacity=n>0;
 }
 return {remaining,capacity,soldOut:remaining===0||!capacity};
}

export function planRoutes(app:FastifyInstance){
 const load=async(id:string)=>{const p=(await pool.query('SELECT * FROM plans WHERE id=$1',[id])).rows[0];if(!p)fail(404,'Plan not found');return p;};
 const shapeOne=async(id:string)=>{const p=await load(id),prices=(await pool.query('SELECT * FROM plan_prices WHERE plan_id=$1 ORDER BY created_at',[id])).rows;return planShape(p,prices,(await countsFor([id])).get(id)||{active:0,pending:0});};

 app.get('/api/plans',async(req)=>{
  admin(req);
  const plans=(await pool.query('SELECT * FROM plans ORDER BY archived_at NULLS FIRST,sort_order,created_at')).rows;
  const prices=(await pool.query('SELECT * FROM plan_prices WHERE active')).rows;
  const counts=await countsFor(plans.map((p:any)=>p.id));
  return plans.map((p:any)=>planShape(p,prices.filter((x:any)=>x.plan_id===p.id),counts.get(p.id)||{active:0,pending:0}));
 });
 app.get('/api/plans/:id',async(req)=>{admin(req);return shapeOne(asId((req.params as any).id));});
 app.post('/api/plans',async(req)=>{
  admin(req);
  const b=req.body as any,v=await validatePlan(b);
  const cfg=(await settings()).billing;
  const prices=b.prices===undefined?[]:validatePrices(b.prices,cfg.currencies);
  let row:any;
  try{
   row=(await pool.query(`INSERT INTO plans(slug,name,description,kind,visibility,active,sort_order,features,preset,limits,options,stock,per_customer_max,trial_once,retention_days)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,[v.slug,v.name,v.description,v.kind,v.visibility,v.active,v.sortOrder,JSON.stringify(v.features),JSON.stringify(v.preset),JSON.stringify(v.limits),JSON.stringify(v.options),v.stock,v.perCustomerMax,v.trialOnce,v.retention])).rows[0];
  }catch(e:any){if(e?.code==='23505')fail(409,'A plan with that address name already exists');throw e;}
  if(prices.length)await savePrices(row.id,prices);
  await audit(req.actor!.id,'plan.create','plan',row.id,{name:v.name,kind:v.kind});
  return shapeOne(row.id);
 });
 app.put('/api/plans/:id',async(req)=>{
  admin(req);
  const id=asId((req.params as any).id),cur=await load(id),b=req.body as any,v=await validatePlan(b,cur);
  try{
   await pool.query(`UPDATE plans SET slug=$2,name=$3,description=$4,visibility=$5,active=$6,sort_order=$7,features=$8,preset=$9,limits=$10,options=$11,stock=$12,per_customer_max=$13,trial_once=$14,retention_days=$15,updated_at=now() WHERE id=$1`,
    [id,v.slug,v.name,v.description,v.visibility,v.active,v.sortOrder,JSON.stringify(v.features),JSON.stringify(v.preset),JSON.stringify(v.limits),JSON.stringify(v.options),v.stock,v.perCustomerMax,v.trialOnce,v.retention]);
  }catch(e:any){if(e?.code==='23505')fail(409,'A plan with that address name already exists');throw e;}
  if(b.prices!==undefined)await savePrices(id,validatePrices(b.prices,(await settings()).billing.currencies));
  await audit(req.actor!.id,'plan.update','plan',id,{name:v.name});
  return shapeOne(id);
 });
 app.put('/api/plans/:id/prices',async(req)=>{
  admin(req);
  const id=asId((req.params as any).id);await load(id);
  await savePrices(id,validatePrices((req.body as any)?.prices,(await settings()).billing.currencies));
  await audit(req.actor!.id,'plan.prices','plan',id);
  return shapeOne(id);
 });
 app.post('/api/plans/:id/duplicate',async(req)=>{
  admin(req);
  const id=asId((req.params as any).id),p=await load(id);
  let slug=`${p.slug}-copy`.slice(0,48);
  for(let n=2;(await pool.query('SELECT 1 FROM plans WHERE slug=$1',[slug])).rowCount;n++)slug=`${p.slug.slice(0,44)}-c${n}`;
  const row=(await pool.query(`INSERT INTO plans(slug,name,description,kind,visibility,active,sort_order,features,preset,limits,options,stock,per_customer_max,trial_once,retention_days)
   SELECT $2,name||' (copy)',description,kind,'hidden',false,sort_order+1,features,preset,limits,options,stock,per_customer_max,trial_once,retention_days FROM plans WHERE id=$1 RETURNING id`,[id,slug])).rows[0];
  await pool.query('INSERT INTO plan_prices(plan_id,cycle,amount,currency,trial_days,setup_fee) SELECT $2,cycle,amount,currency,trial_days,setup_fee FROM plan_prices WHERE plan_id=$1 AND active',[id,row.id]);
  await audit(req.actor!.id,'plan.duplicate','plan',row.id,{from:id});
  return shapeOne(row.id);
 });
 app.post('/api/plans/:id/archive',async(req)=>{admin(req);const id=asId((req.params as any).id);await load(id);await pool.query('UPDATE plans SET archived_at=now(),active=false WHERE id=$1',[id]);await audit(req.actor!.id,'plan.archive','plan',id);return shapeOne(id);});
 app.post('/api/plans/:id/unarchive',async(req)=>{admin(req);const id=asId((req.params as any).id);await load(id);await pool.query('UPDATE plans SET archived_at=NULL WHERE id=$1',[id]);await audit(req.actor!.id,'plan.unarchive','plan',id);return shapeOne(id);});
 app.delete('/api/plans/:id',async(req)=>{
  admin(req);
  const id=asId((req.params as any).id);await load(id);
  const used=(await pool.query('SELECT (SELECT count(*) FROM subscriptions WHERE plan_id=$1)+(SELECT count(*) FROM orders WHERE plan_id=$1) n',[id])).rows[0].n;
  if(Number(used))fail(409,'This plan has subscriptions or orders. Archive it instead; that hides it and keeps the records.');
  await pool.query('DELETE FROM plans WHERE id=$1',[id]);
  await audit(req.actor!.id,'plan.delete','plan',id);
  return {ok:true};
 });
 app.post('/api/plans/reorder',async(req)=>{
  admin(req);
  const ids=(req.body as any)?.ids;
  if(!Array.isArray(ids)||ids.length>200)fail(400,'ids must be a list');
  for(const [i,id] of ids.entries())await pool.query('UPDATE plans SET sort_order=$2 WHERE id=$1',[asId(id),i]);
  return {ok:true};
 });
}

// --- The storefront's view of plans ----------------------------------------------------------------------------
export async function catalog(userId:string|null,opts:{freeOnly?:boolean}={}){
 const cfg=(await settings());
 const plans=(await pool.query("SELECT * FROM plans WHERE active AND archived_at IS NULL AND visibility='public' ORDER BY sort_order,created_at")).rows;
 const prices=(await pool.query('SELECT * FROM plan_prices WHERE active AND plan_id=ANY($1::uuid[])',[plans.map((p:any)=>p.id)])).rows;
 const mine=userId?(await pool.query("SELECT plan_id,count(*)::int n FROM subscriptions WHERE user_id=$1 AND status NOT IN ('canceled','terminated') GROUP BY plan_id",[userId])).rows:[];
 const templateRows=(await pool.query('SELECT id,name,variables,editable_variables FROM templates')).rows;
 const templates=new Map<string,string>(templateRows.map((t:any)=>[t.id,t.name]));
 const varDefs=(templateId:string,keys:string[])=>{const t=templateRows.find((x:any)=>x.id===templateId);if(!t)return [];return effectiveDefs(t).filter((d:any)=>d.userEditable&&!d.secret&&keys.includes(d.key)).map((d:any)=>({key:d.key,label:d.label,description:d.description,type:d.type,options:d.options,min:d.min,max:d.max,required:d.required}));};
 const out=[];
 for(const p of plans){
  const pr=prices.filter((x:any)=>x.plan_id===p.id).sort((a:any,b:any)=>INTERVALS[a.cycle as Interval].order-INTERVALS[b.cycle as Interval].order);
  if(!pr.length)continue;
  if(opts.freeOnly&&!pr.every((x:any)=>Number(x.amount)===0&&Number(x.setup_fee)===0))continue;
  const av=await availability(p);
  if(av.soldOut&&cfg.store.soldOut==='hide')continue;
  const monthly=new Map<string,number>();
  for(const x of pr)if(x.cycle==='month')monthly.set(x.currency,Number(x.amount));
  const owned=mine.find((m:any)=>m.plan_id===p.id)?.n||0;
  const preset=p.preset||{};
  out.push({id:p.id,slug:p.slug,name:p.name,description:p.description,kind:p.kind,features:p.features,highlight:!!p.options?.highlight,badge:p.options?.badge||'',note:p.options?.note||'',free:!!p.options?.free||pr.every((x:any)=>Number(x.amount)===0),
   spec:p.kind==='server'?{template:templates.get(preset.templateId)||preset.templateId,memoryMb:preset.memoryMb,cpuPercent:preset.cpuPercent,diskMb:preset.diskMb,locations:preset.locations||[],allowLocationChoice:preset.allowLocationChoice!==false&&(preset.locations||[]).length!==1,allowNameChoice:preset.allowNameChoice!==false,
    variables:varDefs(preset.templateId,preset.editableVariables||[])}:null,
   prices:pr.map((x:any)=>({id:x.id,cycle:x.cycle,amount:Number(x.amount),currency:x.currency,text:formatMoney(x.amount,x.currency),perMonthText:x.cycle==='month'?null:formatMoney(perMonth(Number(x.amount),x.cycle),x.currency),trialDays:x.trial_days,setupFee:Number(x.setup_fee),setupText:Number(x.setup_fee)?formatMoney(x.setup_fee,x.currency):null,
    savings:cfg.store.showSavings?savingsPercent(monthly.get(x.currency)??null,Number(x.amount),x.cycle):0})),
   stock:av.remaining,soldOut:av.soldOut,owned,canBuyMore:owned<p.per_customer_max});
 }
 return out;
}
