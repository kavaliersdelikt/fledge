import type {FastifyInstance} from 'fastify';
import {pool,withAdvisoryLock,fail} from '../core.js';
import {settings,settingsGuard} from '../settings.js';
import {onActivated} from '../signup.js';
import {planRoutes} from './plans.js';
import {storeRoutes,readiness,clearProviderState} from './store.js';
import {billingAdminRoutes} from './admin.js';
import {webhookRoutes,sweepInbox} from './webhooks.js';
import {sweepBilling,reconcileSweep,grantManual} from './engine.js';

export async function registerBilling(app:FastifyInstance){
 await webhookRoutes(app);
 planRoutes(app);storeRoutes(app);billingAdminRoutes(app);

 // The store cannot be opened until everything it needs works.
 settingsGuard('store',async(value,current)=>{
  if(value.enabled&&!current.store.enabled){
   const missing=(await readiness(value)).filter(c=>c.blocking&&!c.ok);
   if(missing.length)fail(409,`The store cannot open yet: ${missing.map(m=>m.label.toLowerCase()).join('; ')}.`);
  }
 });
 settingsGuard('billing',async(value,current)=>{
  if(value.provider!==current.billing.provider)clearProviderState();
 });

 // New accounts can start with a free plan, and an invitation can carry one.
 onActivated(async userId=>{
  const cfg=(await settings()).signup;
  const plans:string[]=[];
  const inv=(await pool.query("SELECT preferences->>'invitePlan' AS plan FROM users WHERE id=$1",[userId])).rows[0]?.plan;
  if(inv)plans.push(inv);
  if(cfg.defaultPlanSlug){const p=(await pool.query('SELECT id FROM plans WHERE slug=$1 AND active AND archived_at IS NULL',[cfg.defaultPlanSlug])).rows[0];if(p&&!plans.includes(p.id))plans.push(p.id);}
  for(const planId of plans){
   const has=await pool.query("SELECT 1 FROM subscriptions WHERE user_id=$1 AND plan_id=$2 AND status NOT IN ('canceled','terminated')",[userId,planId]);
   if(!has.rowCount)await grantManual({userId,planId,actorId:null}).catch(e=>console.error('Starting plan could not be granted:',e?.message));
  }
 });
}

export async function sweepBillingAll(){
 await withAdvisoryLock(727312,sweepBilling);
 await withAdvisoryLock(727313,reconcileSweep);
 await sweepInbox();
}
