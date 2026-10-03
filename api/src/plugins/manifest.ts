// Plugin manifests: what a plugin is, what it asks for and what settings it exposes.
// Everything in here is pure so it can be tested without a database.

import {safeTest,validPattern} from '../saferegex.js';
export const API_VERSION=1;
export type SettingField={key:string;label:string;type:'string'|'number'|'boolean'|'select'|'secret';default?:string|number|boolean;options?:{value:string;label:string}[];required?:boolean;help?:string;min?:number;max?:number;pattern?:string;placeholder?:string};
export type Catalog={id:string;label:string;kind:string;description?:string};
/** A plugin that can take payments (see billing/provider.ts). */
export type PaymentsCapability={id:string;label:string;intervals:string[];currencies:string[];features:string[]};
export const PAYMENT_INTERVALS=['month','quarter','semiannual','year'];
export const PAYMENT_FEATURES=['checkout','portal','refund','trial','tax','coupons','change'];
export type Manifest={
 id:string;name:string;version:string;apiVersion:number;description:string;author:string;license:string;homepage?:string;
 minPanelVersion?:string;minAgentVersion?:string;permissions:string[];settings:SettingField[];catalogs:Catalog[];hooks:string[];payments?:PaymentsCapability;
};
export class ManifestError extends Error{constructor(public problems:string[]){super(problems.join('; '));this.name='ManifestError';}}

const ID=/^[a-z0-9][a-z0-9-]{1,48}$/;
const VERSION=/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:-[0-9A-Za-z.-]{1,20})?$/;
const HOST=/^(?:\*\.)?(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const KEY=/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
export const KNOWN_HOOKS=['server.created','server.deleted','server.updated','addon.installed','addon.removed'] as const;
export const FIXED_PERMISSIONS=['servers:read','servers:files.write','storage','hooks','payments'];

// Wildcards on hosting platforms would let a plugin talk to any customer's site on that platform.
const SHARED_HOSTING=/\*\.(github\.io|githubusercontent\.com|gitlab\.io|pages\.dev|workers\.dev|vercel\.app|netlify\.app|herokuapp\.com|amazonaws\.com|cloudfront\.net|web\.app|firebaseapp\.com|azurewebsites\.net|onrender\.com|fly\.dev|repl\.co|blogspot\.com|appspot\.com|ngrok\.io|trycloudflare\.com)$/;
export function permissionProblem(p:unknown):string|null{
 if(typeof p!=='string')return 'permissions must be text';
 if(FIXED_PERMISSIONS.includes(p))return null;
 const m=/^network:(.+)$/.exec(p);
 if(!m)return `unknown permission “${p.slice(0,60)}”`;
 const host=m[1];
 if(!HOST.test(host)||/^\*\.[a-z]{2,}$/.test(host))return `“${host}” is not an allowed network host (use a full domain such as api.example.com or *.example.com)`;
 if(SHARED_HOSTING.test(host))return `“${host}” covers a shared hosting platform; name the exact host instead`;
 if(/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(host))return `“${host}” is a private or reserved name`;
 return null;
}
/** Plain-language description for the permission prompt. */
export function describePermission(p:string):string{
 if(p.startsWith('network:'))return `Connect to ${p.slice(8)}`;
 return ({'servers:read':'Read the game, version and add-on folder of servers you open its tools on','servers:files.write':'Add and remove files in server folders on your behalf (only after you confirm an install)','storage':'Keep a small private data store','hooks':'Be notified when servers or add-ons change','payments':'Take payments and manage subscriptions through this provider. It sees order details and customers’ email addresses, and holds your API keys'} as Record<string,string>)[p]||p;
}

const text=(v:unknown,name:string,max:number,problems:string[],required=true)=>{
 if(v===undefined||v===null||v===''){if(required)problems.push(`${name} is required`);return '';}
 if(typeof v!=='string'||v.length>max){problems.push(`${name} must be text up to ${max} characters`);return '';}
 return v.trim();
};

export function validateManifest(raw:unknown):Manifest{
 const problems:string[]=[];
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ManifestError(['The manifest must be a JSON object']);
 const m=raw as Record<string,any>;
 const id=text(m.id,'id',49,problems);
 if(id&&!ID.test(id))problems.push('id must be 2–49 characters: lowercase letters, numbers and hyphens');
 const version=text(m.version,'version',32,problems);
 if(version&&!VERSION.test(version))problems.push('version must look like 1.2.3');
 const name=text(m.name,'name',60,problems);
 if(m.apiVersion!==API_VERSION)problems.push(`apiVersion must be ${API_VERSION} (this panel supports only that)`);
 const description=text(m.description,'description',400,problems);
 const author=text(m.author,'author',80,problems);
 const license=text(m.license,'license',60,problems);
 const homepage=text(m.homepage,'homepage',300,problems,false);
 if(homepage&&!/^https:\/\/[^\s]+$/.test(homepage))problems.push('homepage must be an https URL');
 const minPanelVersion=text(m.minPanelVersion,'minPanelVersion',32,problems,false);
 const minAgentVersion=text(m.minAgentVersion,'minAgentVersion',32,problems,false);
 for(const [k,v] of [['minPanelVersion',minPanelVersion],['minAgentVersion',minAgentVersion]])if(v&&!VERSION.test(v))problems.push(`${k} must look like 1.2.3`);
 const permissions:string[]=[];
 if(m.permissions!==undefined){
  if(!Array.isArray(m.permissions)||m.permissions.length>20)problems.push('permissions must be a list of at most 20 entries');
  else for(const p of m.permissions){const bad=permissionProblem(p);if(bad)problems.push(bad);else if(!permissions.includes(p))permissions.push(p);}
 }
 const settings:SettingField[]=[];
 if(m.settings!==undefined){
  const fields=Array.isArray(m.settings)?m.settings:m.settings?.fields;
  if(!Array.isArray(fields)||fields.length>30)problems.push('settings must be a list of at most 30 fields');
  else for(const f of fields){
   if(!f||typeof f!=='object'){problems.push('each setting must be an object');continue;}
   const key=String(f.key||'');
   if(!KEY.test(key)){problems.push(`setting key “${key.slice(0,40)}” is not valid`);continue;}
   if(settings.some(s=>s.key===key)){problems.push(`setting “${key}” is declared twice`);continue;}
   if(!['string','number','boolean','select','secret'].includes(f.type)){problems.push(`setting “${key}” has an unknown type`);continue;}
   const field:SettingField={key,label:text(f.label,`setting ${key} label`,80,problems),type:f.type};
   if(f.default!==undefined){
    const t=typeof f.default;
    if((f.type==='number'&&t!=='number')||(f.type==='boolean'&&t!=='boolean')||((f.type==='string'||f.type==='select'||f.type==='secret')&&t!=='string'))problems.push(`setting “${key}” default has the wrong type`);
    else field.default=f.default;
   }
   if(f.type==='select'){
    if(!Array.isArray(f.options)||!f.options.length||f.options.length>50||f.options.some((o:any)=>typeof o?.value!=='string'||typeof o?.label!=='string'))problems.push(`select setting “${key}” needs options with value and label`);
    else field.options=f.options.map((o:any)=>({value:o.value.slice(0,100),label:o.label.slice(0,100)}));
   }
   if(typeof f.required==='boolean')field.required=f.required;
   if(typeof f.help==='string')field.help=f.help.slice(0,300);
   if(typeof f.placeholder==='string')field.placeholder=f.placeholder.slice(0,100);
   if(typeof f.min==='number')field.min=f.min;
   if(typeof f.max==='number')field.max=f.max;
   if(typeof f.pattern==='string'){try{if(!validPattern(f.pattern))throw 0;field.pattern=f.pattern;}catch{problems.push(`setting “${key}” has an invalid pattern`);}}
   settings.push(field);
  }
 }
 const catalogs:Catalog[]=[];
 if(m.catalogs!==undefined){
  if(!Array.isArray(m.catalogs)||m.catalogs.length>4)problems.push('catalogs must be a list of at most 4 entries');
  else for(const c of m.catalogs){
   if(!c||!KEY.test(String(c.id||''))||typeof c.label!=='string'||!/^[a-z][a-z0-9-]{0,30}$/.test(String(c.kind||''))){problems.push('each catalog needs an id, label and kind');continue;}
   catalogs.push({id:c.id,label:c.label.slice(0,60),kind:c.kind,...(typeof c.description==='string'?{description:c.description.slice(0,200)}:{})});
  }
 }
 const hooks:string[]=[];
 if(m.hooks!==undefined){
  if(!Array.isArray(m.hooks))problems.push('hooks must be a list');
  else for(const h of m.hooks){if(!KNOWN_HOOKS.includes(h))problems.push(`unknown hook “${String(h).slice(0,40)}”`);else if(!hooks.includes(h))hooks.push(h);}
  if(hooks.length&&!permissions.includes('hooks'))problems.push('declaring hooks requires the "hooks" permission');
 }
 if(catalogs.length&&!permissions.includes('servers:read'))problems.push('a catalog provider needs the "servers:read" permission');
 let payments:PaymentsCapability|undefined;
 if(m.payments!==undefined){
  const p=m.payments;
  if(!p||typeof p!=='object'||Array.isArray(p))problems.push('payments must be an object');
  else{
   if(!KEY.test(String(p.id||'')))problems.push('payments needs an id');
   const label=text(p.label,'payments label',60,problems);
   const intervals=Array.isArray(p.intervals)?p.intervals.filter((x:unknown)=>PAYMENT_INTERVALS.includes(x as string)):[];
   const features=Array.isArray(p.features)?p.features.filter((x:unknown)=>PAYMENT_FEATURES.includes(x as string)):[];
   const currencies=Array.isArray(p.currencies)?p.currencies.filter((x:unknown)=>typeof x==='string'&&/^[a-z]{3}$/.test(x)).slice(0,200):[];
   if(!intervals.length)problems.push('payments must list the intervals it supports');
   if(!features.includes('checkout'))problems.push('a payment provider must support "checkout"');
   if(!permissions.includes('payments'))problems.push('a payment provider needs the "payments" permission');
   payments={id:String(p.id),label,intervals,currencies,features};
  }
 }
 if(permissions.includes('payments')&&!m.payments)problems.push('the "payments" permission is only for payment providers');
 if(problems.length)throw new ManifestError(problems);
 return {id,name,version,apiVersion:API_VERSION,description,author,license,...(homepage?{homepage}:{}),...(minPanelVersion?{minPanelVersion}:{}),...(minAgentVersion?{minAgentVersion}:{}),permissions,settings,catalogs,hooks,...(payments?{payments}:{})};
}

export const networkHosts=(permissions:string[])=>permissions.filter(p=>p.startsWith('network:')).map(p=>p.slice(8));

export type SettingsResult={values:Record<string,unknown>;secrets:Record<string,string>};
/**
 * Validates submitted settings against the manifest. Secret fields left out (or null)
 * keep their stored value; an empty string clears them.
 */
export function validateSettings(fields:SettingField[],input:unknown,storedSecrets:Record<string,string>):SettingsResult{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new ManifestError(['Settings must be an object']);
 const body=input as Record<string,unknown>,values:Record<string,unknown>={},secrets:Record<string,string>={},problems:string[]=[];
 for(const k of Object.keys(body))if(!fields.some(f=>f.key===k))problems.push(`“${k.slice(0,40)}” is not a setting of this plugin`);
 for(const f of fields){
  const raw=body[f.key];
  if(f.type==='secret'){
   if(raw===undefined||raw===null){if(storedSecrets[f.key])secrets[f.key]=storedSecrets[f.key];else if(f.required)problems.push(`${f.label} is required`);continue;}
   if(typeof raw!=='string'||raw.length>512){problems.push(`${f.label} must be text up to 512 characters`);continue;}
   if(raw===''){if(f.required)problems.push(`${f.label} is required`);continue;}
   secrets[f.key]=raw;continue;
  }
  const value=raw===undefined||raw===null||raw===''?f.default:raw;
  if(value===undefined){if(f.required)problems.push(`${f.label} is required`);continue;}
  switch(f.type){
   case 'string':
    if(typeof value!=='string'||value.length>500){problems.push(`${f.label} must be text up to 500 characters`);break;}
    if(f.pattern&&value&&!safeTest(f.pattern,value)){problems.push(`${f.label} has an invalid format`);break;}
    values[f.key]=value.trim();break;
   case 'number':{
    const n=typeof value==='string'&&value.trim()!==''?Number(value):value;
    if(typeof n!=='number'||!Number.isFinite(n)){problems.push(`${f.label} must be a number`);break;}
    if((f.min!==undefined&&n<f.min)||(f.max!==undefined&&n>f.max)){problems.push(`${f.label} must be between ${f.min??'−∞'} and ${f.max??'∞'}`);break;}
    values[f.key]=n;break;}
   case 'boolean':
    if(typeof value!=='boolean'){problems.push(`${f.label} must be on or off`);break;}
    values[f.key]=value;break;
   case 'select':
    if(typeof value!=='string'||!f.options?.some(o=>o.value===value)){problems.push(`${f.label} must be one of the listed options`);break;}
    values[f.key]=value;break;
  }
 }
 if(problems.length)throw new ManifestError(problems);
 return {values,secrets};
}
