import {fail} from './core.js';

// Settings sections added in 0.7.1.1 "Rookery": sign-up, self-service servers, limits,
// billing and the store. Defaults describe a panel that behaves exactly like 0.6.2.1:
// sign-up, self-service and the store are off, and limits only enforce what is configured.

export const LIMIT_NUMBERS=['servers','runningServers','memoryMb','cpuPercent','diskMb','maxServerMemoryMb','maxServerCpuPercent','maxServerDiskMb','backups','backupsPerServer','backupStorageMb','extraPorts','collaboratorsPerServer','schedulesPerServer'] as const;
export const LIMIT_FLAGS=['selfCreate','selfDelete','sftp','addons','schedules','collaborators','extraPortsAllowed'] as const;
export const LIMIT_LISTS=['allowedTemplates','allowedLocations'] as const;
export type LimitNumber=typeof LIMIT_NUMBERS[number];
export type LimitFlag=typeof LIMIT_FLAGS[number];
/** One layer of limits. A number is a cap, null means unlimited, a missing key means "inherit". */
export type LimitSet={[K in LimitNumber]?:number|null}&{[K in LimitFlag]?:boolean}&{allowedTemplates?:string[]|null;allowedLocations?:string[]|null};

export type SignupSettings={mode:'off'|'open'|'approval'|'invite';allowedDomains:string[];blockedDomains:string[];blockDisposable:boolean;captchaProvider:'none'|'turnstile'|'hcaptcha';captchaSiteKey:string;captchaSecret:string;
 requireTerms:boolean;termsUrl:string;privacyUrl:string;termsVersion:string;defaultPlanSlug:string;welcomeEmail:boolean;notifyAdmins:boolean;
 perIpPerHour:number;perEmailPerDay:number;globalPerHour:number;unverifiedDays:number;rejectCommonPasswords:boolean;minPasswordLength:number;
 allowAccountDeletion:boolean;deletionGraceDays:number;allowEmailChange:boolean;allowDataExport:boolean};
export type SelfServiceSettings={mode:'off'|'presets'|'custom';allowDelete:boolean;deleteCoolingHours:number;backupBeforeDelete:boolean;createsPerHour:number;allowedLocations:string[];requireVerifiedEmail:boolean;allowRename:boolean};
export type LimitsSettings={enabled:boolean;mode:'enforce'|'warn';adminOverride:'force'|'always';allowOverrides:boolean;warnPercent:number;showUsage:boolean;notifyCustomer:boolean;countPlanServers:boolean;defaults:LimitSet};
export type BillingSettings={provider:string;currency:string;currencies:string[];
 reminderDays:number[];suspendAfterDays:number;terminateAfterDays:number;autoTerminate:boolean;retentionDays:number;finalBackup:boolean;
 cancelDefault:'period_end'|'immediate';allowCustomerCancel:boolean;allowResume:boolean;allowPlanChange:boolean;allowDowngrade:boolean;
 trialEndingDays:number;renewalReminderDays:number;provisionRetryHours:number;failedFulfilment:'manual'|'refund';reconcileMinutes:number;
 checkoutsPerHour:number;orderExpiryHours:number;notifyAdmins:boolean;allowManualGrants:boolean;suspendOnDispute:boolean;billingHoldBlocksStart:boolean};
export type StoreSettings={enabled:boolean;publicCatalog:boolean;title:string;intro:string;termsUrl:string;privacyUrl:string;withdrawalNotice:string;requireTerms:boolean;
 companyName:string;companyAddress:string;companyEmail:string;companyTaxId:string;supportUrl:string;
 automaticTax:boolean;collectAddress:boolean;collectTaxId:boolean;promoCodes:boolean;taxNote:string;showSavings:boolean;defaultInterval:'month'|'quarter'|'semiannual'|'year';soldOut:'show'|'hide';requireVerifiedEmail:boolean;maxActivePerCustomer:number};

export const defaultSignup=():SignupSettings=>({mode:'off',allowedDomains:[],blockedDomains:[],blockDisposable:true,captchaProvider:'none',captchaSiteKey:'',captchaSecret:'',
 requireTerms:false,termsUrl:'',privacyUrl:'',termsVersion:'1',defaultPlanSlug:'',welcomeEmail:true,notifyAdmins:true,
 perIpPerHour:5,perEmailPerDay:3,globalPerHour:200,unverifiedDays:7,rejectCommonPasswords:true,minPasswordLength:12,
 allowAccountDeletion:true,deletionGraceDays:14,allowEmailChange:true,allowDataExport:true});
export const defaultSelfService=():SelfServiceSettings=>({mode:'off',allowDelete:false,deleteCoolingHours:24,backupBeforeDelete:true,createsPerHour:10,allowedLocations:[],requireVerifiedEmail:true,allowRename:true});
export const defaultLimits=():LimitsSettings=>({enabled:true,mode:'enforce',adminOverride:'force',allowOverrides:true,warnPercent:80,showUsage:true,notifyCustomer:true,countPlanServers:false,defaults:{}});
export const defaultBilling=():BillingSettings=>({provider:'',currency:'eur',currencies:['eur','usd','gbp'],
 reminderDays:[0,3,14],suspendAfterDays:7,terminateAfterDays:30,autoTerminate:false,retentionDays:30,finalBackup:true,
 cancelDefault:'period_end',allowCustomerCancel:true,allowResume:true,allowPlanChange:true,allowDowngrade:true,
 trialEndingDays:3,renewalReminderDays:7,provisionRetryHours:24,failedFulfilment:'manual',reconcileMinutes:15,
 checkoutsPerHour:5,orderExpiryHours:24,notifyAdmins:true,allowManualGrants:true,suspendOnDispute:true,billingHoldBlocksStart:true});
export const defaultStore=():StoreSettings=>({enabled:false,publicCatalog:false,title:'Store',intro:'',termsUrl:'',privacyUrl:'',withdrawalNotice:'',requireTerms:true,
 companyName:'',companyAddress:'',companyEmail:'',companyTaxId:'',supportUrl:'',automaticTax:false,collectAddress:false,collectTaxId:false,promoCodes:false,taxNote:'',
 showSavings:true,defaultInterval:'month',soldOut:'show',requireVerifiedEmail:true,maxActivePerCustomer:20});

// --- Small validators ---------------------------------------------------------------------
const bool=(v:any,name:string)=>{if(typeof v!=='boolean')fail(400,`${name} must be true or false`);return v as boolean;};
const str=(v:any,name:string,max=512)=>{if(v===undefined||v===null)return '';if(typeof v!=='string'||v.length>max)fail(400,`${name} must be text (max ${max})`);return v.trim();};
const int=(v:any,name:string,min:number,max:number)=>{const n=Number(v);if(v===''||v===null||v===undefined||!Number.isInteger(n)||n<min||n>max)fail(400,`${name} must be a whole number from ${min} to ${max}`);return n;};
const oneOf=<T extends string>(v:any,name:string,options:readonly T[])=>{if(!options.includes(v))fail(400,`${name} must be one of: ${options.join(', ')}`);return v as T;};
const urlish=(v:any,name:string)=>{const s=str(v,name,500);if(!s)return s;let u:URL;try{u=new URL(s);}catch{return fail(400,`${name} must be a web address`);}if(!['https:','http:'].includes(u.protocol))fail(400,`${name} must start with https://`);return s;};
const list=(v:any,name:string,max:number,each:(s:string)=>string):string[]=>{if(v===undefined||v===null)return [];if(!Array.isArray(v)||v.length>max)fail(400,`${name} must be a list of at most ${max} entries`);return [...new Set((v as unknown[]).map(x=>each(str(x,name,200))).filter(Boolean))];};
const domain=(s:string)=>{const d=s.toLowerCase().replace(/^@/,'');if(!d)return '';if(!/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d))fail(400,`“${d.slice(0,60)}” is not a domain name`);return d;};
const slugLike=(s:string)=>{if(!s)return '';if(!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s))fail(400,`“${s.slice(0,40)}” is not a valid identifier`);return s;};
export const currencyCode=(s:string)=>{const c=s.toLowerCase();if(!/^[a-z]{3}$/.test(c))fail(400,`“${s.slice(0,10)}” is not a three-letter currency code`);return c;};

/** The six limits that existed before 0.7 keep their stored names so the API and old tooling see no change. */
export const LEGACY_NAMES:Record<string,LimitNumber>={maxServers:'servers',maxMemoryMb:'memoryMb',maxCpuPercent:'cpuPercent',maxDiskMb:'diskMb',maxBackups:'backups',maxExtraPorts:'extraPorts'};
export function toStorage(set:LimitSet):Record<string,unknown>{
 const back=Object.fromEntries(Object.entries(LEGACY_NAMES).map(([legacy,canonical])=>[canonical,legacy]));
 return Object.fromEntries(Object.entries(set).map(([k,v])=>[back[k]||k,v]));
}
/** Reads a stored layer (legacy or canonical names) into canonical names. */
export function fromStorage(raw:unknown):LimitSet{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {};
 const out:any={};
 for(const [k,v] of Object.entries(raw as Record<string,unknown>))out[LEGACY_NAMES[k]||k]=v;
 return out;
}

/** Validates a layer of limits (defaults, plan allowances, customer overrides). Unknown keys are refused. */
export function validateLimitSet(input:unknown,name='limits'):LimitSet{
 if(input===null||input===undefined)return {};
 if(typeof input!=='object'||Array.isArray(input))fail(400,`${name} must be an object`);
 const body=input as Record<string,unknown>,out:any={};
 const known=new Set<string>([...LIMIT_NUMBERS,...LIMIT_FLAGS,...LIMIT_LISTS,'maxServers','maxMemoryMb','maxCpuPercent','maxDiskMb','maxBackups','maxExtraPorts']);
 for(const k of Object.keys(body))if(!known.has(k))fail(400,`Unknown limit “${k.slice(0,40)}”`);
 // The 0.6.x names keep working: they are the same numbers.
  for(const [k,v] of Object.entries(body)){
  const key=(LEGACY_NAMES[k]||k) as string;
  if(v===undefined||v==='')continue;
  if((LIMIT_NUMBERS as readonly string[]).includes(key)){
   if(v===null){out[key]=null;continue;}
   const n=Number(v);
   if(!Number.isInteger(n)||n<0||n>1e9)fail(400,`${key} must be a whole number from 0 to 1000000000, or empty for no limit`);
   out[key]=n;
  }else if((LIMIT_FLAGS as readonly string[]).includes(key)){
   if(typeof v!=='boolean')fail(400,`${key} must be true or false`);
   out[key]=v;
  }else{
   if(v===null){out[key]=null;continue;}
   if(!Array.isArray(v)||v.length>200||v.some((x:any)=>typeof x!=='string'||x.length>120))fail(400,`${key} must be a list of names`);
   out[key]=[...new Set((v as string[]).map(x=>x.trim()).filter(Boolean))];
  }
 }
 return out;
}

export function validateRookery(section:string,body:any,current:any):any{
 if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Expected an object');
 switch(section){
  case 'signup':{
   const cur=current.signup as SignupSettings;
   const v:SignupSettings={
    mode:oneOf(body.mode,'Sign-up mode',['off','open','approval','invite'] as const),
    allowedDomains:list(body.allowedDomains,'Allowed domains',100,domain),blockedDomains:list(body.blockedDomains,'Blocked domains',500,domain),
    blockDisposable:bool(body.blockDisposable,'Block disposable addresses'),
    captchaProvider:oneOf(body.captchaProvider??'none','Bot protection',['none','turnstile','hcaptcha'] as const),
    captchaSiteKey:str(body.captchaSiteKey,'Site key',200),
    captchaSecret:body.captchaSecret===undefined||body.captchaSecret===null?cur.captchaSecret:str(body.captchaSecret,'Secret key',300),
    requireTerms:bool(body.requireTerms,'Require terms'),termsUrl:urlish(body.termsUrl,'Terms address'),privacyUrl:urlish(body.privacyUrl,'Privacy address'),
    termsVersion:str(body.termsVersion||'1','Terms version',40)||'1',defaultPlanSlug:slugLike(str(body.defaultPlanSlug,'Default plan',64)),
    welcomeEmail:bool(body.welcomeEmail,'Welcome email'),notifyAdmins:bool(body.notifyAdmins,'Notify administrators'),
    perIpPerHour:int(body.perIpPerHour,'Registrations per address and hour',1,1000),perEmailPerDay:int(body.perEmailPerDay,'Attempts per email and day',1,100),
    globalPerHour:int(body.globalPerHour,'Registrations per hour overall',1,100000),unverifiedDays:int(body.unverifiedDays,'Delete unverified accounts after (days)',1,365),
    rejectCommonPasswords:bool(body.rejectCommonPasswords,'Reject common passwords'),minPasswordLength:int(body.minPasswordLength,'Minimum password length',12,128),
    allowAccountDeletion:bool(body.allowAccountDeletion,'Account deletion'),deletionGraceDays:int(body.deletionGraceDays,'Deletion grace period (days)',0,90),
    allowEmailChange:bool(body.allowEmailChange,'Email change'),allowDataExport:bool(body.allowDataExport,'Data export'),
   };
   if(v.captchaProvider!=='none'&&(!v.captchaSiteKey||!v.captchaSecret))fail(400,'A site key and a secret key are needed for bot protection');
   if(v.requireTerms&&!v.termsUrl)fail(400,'Add the address of your terms before requiring them');
   return v;
  }
  case 'selfService':{
   return {
    mode:oneOf(body.mode,'Self-service mode',['off','presets','custom'] as const),allowDelete:bool(body.allowDelete,'Customers may delete servers'),
    deleteCoolingHours:int(body.deleteCoolingHours,'Deletion cooling-off (hours)',0,720),backupBeforeDelete:bool(body.backupBeforeDelete,'Back up before deleting'),
    createsPerHour:int(body.createsPerHour,'Servers per customer and hour',1,1000),allowedLocations:list(body.allowedLocations,'Locations',100,s=>s),
    requireVerifiedEmail:bool(body.requireVerifiedEmail,'Require a verified email'),allowRename:bool(body.allowRename,'Customers may rename servers'),
   } satisfies SelfServiceSettings;
  }
  case 'limits':{
   return {
    enabled:bool(body.enabled,'Limits'),mode:oneOf(body.mode,'Limit mode',['enforce','warn'] as const),adminOverride:oneOf(body.adminOverride,'Administrator override',['force','always'] as const),
    allowOverrides:bool(body.allowOverrides,'Per-customer overrides'),warnPercent:int(body.warnPercent,'Warn at (percent)',1,100),showUsage:bool(body.showUsage,'Show usage to customers'),
    notifyCustomer:bool(body.notifyCustomer,'Notify customers'),countPlanServers:bool(body.countPlanServers,'Count plan servers'),defaults:validateLimitSet(body.defaults,'Defaults'),
   } satisfies LimitsSettings;
  }
  case 'billing':{
   const currencies=list(body.currencies,'Currencies',20,currencyCode);
   const currency=currencyCode(str(body.currency||'eur','Default currency',3));
   if(!currencies.includes(currency))currencies.unshift(currency);
   const reminders=Array.isArray(body.reminderDays)?body.reminderDays.map((x:any)=>int(x,'Reminder day',0,365)):fail(400,'Reminder days must be a list');
   if(reminders.length>6)fail(400,'At most six reminders');
   const v:BillingSettings={
    provider:slugLike(str(body.provider,'Payment provider',64)),currency,currencies,
    reminderDays:[...new Set(reminders as number[])].sort((a,b)=>a-b),suspendAfterDays:int(body.suspendAfterDays,'Suspend after (days)',0,365),
    terminateAfterDays:int(body.terminateAfterDays,'Terminate after (days)',1,3650),autoTerminate:bool(body.autoTerminate,'Terminate automatically'),
    retentionDays:int(body.retentionDays,'Keep data after cancellation (days)',0,3650),finalBackup:bool(body.finalBackup,'Back up before terminating'),
    cancelDefault:oneOf(body.cancelDefault,'Cancellation timing',['period_end','immediate'] as const),allowCustomerCancel:bool(body.allowCustomerCancel,'Customers may cancel'),
    allowResume:bool(body.allowResume,'Customers may resume'),allowPlanChange:bool(body.allowPlanChange,'Customers may change plan'),allowDowngrade:bool(body.allowDowngrade,'Customers may downgrade'),
    trialEndingDays:int(body.trialEndingDays,'Trial ending notice (days)',0,30),renewalReminderDays:int(body.renewalReminderDays,'Renewal reminder (days)',0,60),
    provisionRetryHours:int(body.provisionRetryHours,'Retry provisioning for (hours)',1,168),failedFulfilment:oneOf(body.failedFulfilment,'When a paid server cannot be created',['manual','refund'] as const),
    reconcileMinutes:int(body.reconcileMinutes,'Reconcile every (minutes)',5,1440),checkoutsPerHour:int(body.checkoutsPerHour,'Checkouts per customer and hour',1,100),
    orderExpiryHours:int(body.orderExpiryHours,'Order expiry (hours)',1,168),notifyAdmins:bool(body.notifyAdmins,'Notify administrators'),
    allowManualGrants:bool(body.allowManualGrants,'Manual grants'),suspendOnDispute:bool(body.suspendOnDispute,'Suspend on dispute'),billingHoldBlocksStart:bool(body.billingHoldBlocksStart,'Billing suspension blocks start'),
   };
   if(v.terminateAfterDays<=v.suspendAfterDays)fail(400,'Termination must come after suspension');
   return v;
  }
  case 'store':{
   const v:StoreSettings={
    enabled:bool(body.enabled,'Store'),publicCatalog:bool(body.publicCatalog,'Public catalogue'),title:str(body.title||'Store','Store title',40)||'Store',intro:str(body.intro,'Introduction',600),
    termsUrl:urlish(body.termsUrl,'Terms address'),privacyUrl:urlish(body.privacyUrl,'Privacy address'),withdrawalNotice:str(body.withdrawalNotice,'Withdrawal notice',1200),requireTerms:bool(body.requireTerms,'Require terms'),
    companyName:str(body.companyName,'Company name',120),companyAddress:str(body.companyAddress,'Company address',400),companyEmail:str(body.companyEmail,'Company email',200),companyTaxId:str(body.companyTaxId,'Tax number',60),
    supportUrl:urlish(body.supportUrl,'Support address'),automaticTax:bool(body.automaticTax,'Automatic tax'),collectAddress:bool(body.collectAddress,'Collect billing address'),collectTaxId:bool(body.collectTaxId,'Collect tax number'),
    promoCodes:bool(body.promoCodes,'Promotion codes'),taxNote:str(body.taxNote,'Tax note',300),showSavings:bool(body.showSavings,'Show savings'),
    defaultInterval:oneOf(body.defaultInterval,'Default interval',['month','quarter','semiannual','year'] as const),soldOut:oneOf(body.soldOut,'Sold-out plans',['show','hide'] as const),
    requireVerifiedEmail:bool(body.requireVerifiedEmail,'Require a verified email'),maxActivePerCustomer:int(body.maxActivePerCustomer,'Active subscriptions per customer',1,1000),
   };
   if(v.companyEmail&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v.companyEmail))fail(400,'Company email must look like billing@example.com');
   return v;
  }
 }
 return fail(404,'Unknown settings section');
}
