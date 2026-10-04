import {pool} from './core.js';
import {callPlugin} from './plugins/manager.js';

// Notification styles. A plugin that declares `notifications` (and holds the "notifications"
// permission) lays out an event as a richer message for one kind of channel. It only returns
// data: Fledge sends the message itself, so the plugin never sees the webhook address and needs
// no network permission. Whatever it returns is rebuilt here from an allow-list (sizes, URLs,
// mentions) before anything leaves the panel, and any failure falls back to the plain message.

export type StyleInfo={id:string;label:string;description?:string};
export type Formatter={pluginId:string;styles:StyleInfo[]};

/** The enabled, trusted plugin that formats Discord messages, if any. */
export async function discordFormatter():Promise<Formatter|null>{
 const r=(await pool.query("SELECT id,manifest FROM plugins WHERE enabled AND manifest->'notifications'->>'channel'='discord' AND 'notifications'=ANY(granted_permissions) ORDER BY id LIMIT 1")).rows[0];
 return r?{pluginId:r.id,styles:r.manifest.notifications.styles as StyleInfo[]}:null;
}
export async function discordStyles():Promise<StyleInfo[]>{
 const f=await discordFormatter();
 return [{id:'plain',label:'Plain text',description:'One line of text. Works everywhere.'},...(f?.styles||[])];
}

const str=(v:unknown,max:number)=>typeof v==='string'?v.slice(0,max):undefined;
const url=(v:unknown,max=500)=>{
 if(typeof v!=='string'||v.length>max)return undefined;
 try{const u=new URL(v);return (u.protocol==='https:'||u.protocol==='http:')&&!u.username&&!u.password?u.toString():undefined;}catch{return undefined;}
};
const secureUrl=(v:unknown)=>{const u=url(v);return u&&u.startsWith('https:')?u:undefined;};

/** Rebuilds a Discord webhook body from what the plugin returned. Exported for tests. */
export function cleanDiscord(raw:unknown,scope:'panel'|'user'):Record<string,unknown>|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const r=raw as Record<string,any>,out:Record<string,unknown>={};
 const content=str(r.content,2000);if(content)out.content=content;
 const username=str(r.username,80);if(username?.trim())out.username=username.trim();
 const avatar=secureUrl(r.avatar_url);if(avatar)out.avatar_url=avatar;
 // Only roles can be mentioned, only on the administrator's own channels, and only by plain id.
 const roles=scope==='panel'&&r.allowed_mentions&&Array.isArray(r.allowed_mentions.roles)?[...new Set((r.allowed_mentions.roles as unknown[]).filter((x):x is string=>typeof x==='string'&&/^\d{17,20}$/.test(x)))].slice(0,3):[];
 out.allowed_mentions=roles.length?{parse:[],roles}:{parse:[]};
 let budget=5800;
 const embeds:Record<string,unknown>[]=[];
 for(const e of (Array.isArray(r.embeds)?r.embeds.slice(0,3):[])){
  if(!e||typeof e!=='object')continue;
  const c:Record<string,unknown>={};
  const title=str(e.title,256),desc=str(e.description,4096);
  if(title){c.title=title;budget-=title.length;}
  if(desc){c.description=desc.slice(0,Math.max(0,budget));budget-=(c.description as string).length;}
  const eu=url(e.url);if(eu)c.url=eu;
  if(Number.isInteger(e.color)&&e.color>=0&&e.color<=0xffffff)c.color=e.color;
  if(typeof e.timestamp==='string'&&!Number.isNaN(Date.parse(e.timestamp)))c.timestamp=new Date(e.timestamp).toISOString();
  if(e.author&&typeof e.author==='object'){const n=str(e.author.name,256);if(n){c.author={name:n,...(url(e.author.url)?{url:url(e.author.url)}:{}),...(secureUrl(e.author.icon_url)?{icon_url:secureUrl(e.author.icon_url)}:{})};budget-=n.length;}}
  if(e.footer&&typeof e.footer==='object'){const n=str(e.footer.text,2048);if(n){c.footer={text:n,...(secureUrl(e.footer.icon_url)?{icon_url:secureUrl(e.footer.icon_url)}:{})};budget-=n.length;}}
  const th=e.thumbnail&&typeof e.thumbnail==='object'?secureUrl(e.thumbnail.url):undefined;if(th)c.thumbnail={url:th};
  const fields:Record<string,unknown>[]=[];
  for(const f of (Array.isArray(e.fields)?e.fields.slice(0,25):[])){
   const n=str(f?.name,256)?.trim(),v=str(f?.value,1024)?.trim();
   if(!n||!v||budget<n.length+v.length)continue;
   fields.push({name:n,value:v,inline:f.inline===true});budget-=n.length+v.length;
  }
  if(fields.length)c.fields=fields;
  if(Object.keys(c).length)embeds.push(c);
 }
 if(embeds.length)out.embeds=embeds;
 return out.content||out.embeds?out:null;
}

export type RenderInput={style:string;scope:'panel'|'user';brand:string;panelUrl:string;
 event:{kind:string;severity:string;title:string;body:string;server?:{id:string;name:string}|null;nodeId?:string|null;data?:Record<string,unknown>;at?:string}};

/** The message body for a Discord channel in the chosen style, or null to use the plain one. */
export async function renderDiscord(i:RenderInput):Promise<Record<string,unknown>|null>{
 if(!i.style||i.style==='plain')return null;
 const f=await discordFormatter();
 if(!f||!f.styles.some(s=>s.id===i.style))return null;
 let data:Record<string,unknown>={};
 try{const j=JSON.stringify(i.event.data||{});data=j.length<=8000?JSON.parse(j):{};}catch{data={};}
 const out=await callPlugin<unknown>(f.pluginId,'formatNotification',[{channel:'discord',style:i.style,scope:i.scope,brand:i.brand,panelUrl:i.panelUrl,event:{...i.event,data}}],{limits:{deadlineMs:3000}});
 return cleanDiscord(out,i.scope);
}
