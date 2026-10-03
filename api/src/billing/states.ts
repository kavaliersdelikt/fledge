// The subscription state machine. Pure functions only: no database, no clock of their own.
// Every change of status in the billing code goes through `canMove`, so an event that arrives
// late, twice or out of order cannot move a subscription somewhere it should not be.

export type Status='incomplete'|'trialing'|'active'|'past_due'|'suspended'|'canceled'|'terminated';
export const STATUSES:Status[]=['incomplete','trialing','active','past_due','suspended','canceled','terminated'];

const MOVES:Record<Status,Status[]>={
 incomplete:['trialing','active','canceled'],
 trialing:['active','past_due','suspended','canceled'],
 active:['past_due','suspended','canceled'],
 past_due:['active','suspended','canceled'],
 suspended:['active','canceled','terminated'],
 canceled:['terminated','active'],
 terminated:[],
};
export const canMove=(from:Status,to:Status)=>from===to||MOVES[from].includes(to);
export const isLive=(s:Status)=>s==='trialing'||s==='active'||s==='past_due';
export const isFinal=(s:Status)=>s==='terminated';
/** A subscription whose customer is still entitled to the product. */
export const grantsAccess=(s:Status)=>isLive(s);

/** What a payment provider reports, normalised by the payment plugin. */
export type ProviderStatus='incomplete'|'incomplete_expired'|'trialing'|'active'|'past_due'|'unpaid'|'canceled'|'paused';

/**
 * Maps the provider's status to ours, given where we are. The provider can say "unpaid" long after
 * we suspended the server; that must not bring it back to "past due", so suspension is sticky until
 * a payment (provider says active/trialing) lifts it.
 */
export function mapProviderStatus(current:Status,p:ProviderStatus):Status{
 switch(p){
  case 'active':return 'active';
  case 'trialing':return 'trialing';
  case 'incomplete':return current==='incomplete'?'incomplete':current;
  case 'incomplete_expired':return current==='incomplete'?'canceled':current;
  case 'past_due':
  case 'unpaid':return current==='suspended'||current==='canceled'||current==='terminated'?current:'past_due';
  case 'paused':return current==='canceled'||current==='terminated'?current:'suspended';
  case 'canceled':return current==='terminated'?current:'canceled';
 }
}

export type Dunning={sent?:Record<string,string>};
export type DunningConfig={reminderDays:number[];suspendAfterDays:number;terminateAfterDays:number;autoTerminate:boolean};
export type DunningAction={kind:'reminder'|'final'|'suspend'|'terminate';day:number};

/**
 * What should happen now for a subscription that has been unpaid since `since`.
 * Returns actions in order; the caller performs them and records them in `dunning.sent`.
 */
export function dunningActions(status:Status,since:Date|null,now:Date,cfg:DunningConfig,done:Dunning={}):DunningAction[]{
 if(!since||(status!=='past_due'&&status!=='suspended'))return [];
 const days=Math.floor((now.getTime()-since.getTime())/86400000);
 const sent=done.sent||{};
 const out:DunningAction[]=[];
 for(const d of cfg.reminderDays){
  if(d<=0||d>days||sent[`r${d}`])continue;
  out.push({kind:d>=cfg.suspendAfterDays?'final':'reminder',day:d});
 }
 if(status==='past_due'&&days>=cfg.suspendAfterDays&&!sent.suspend)out.push({kind:'suspend',day:cfg.suspendAfterDays});
 if(cfg.autoTerminate&&days>=cfg.terminateAfterDays&&!sent.terminate)out.push({kind:'terminate',day:cfg.terminateAfterDays});
 return out;
}

/** Full days between two dates, never negative. */
export const daysBetween=(a:Date,b:Date)=>Math.max(0,Math.floor((b.getTime()-a.getTime())/86400000));
