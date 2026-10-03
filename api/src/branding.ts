import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,audit} from './core.js';
import {settings,invalidateSettings} from './settings.js';
import {defaultThemeSpec,sanitizeThemeSpec,checkTheme,themeCss,derivePalette,type ThemeSpec} from '../../shared/theme.js';

// Appearance (0.6.2.1 "Plumage"): the panel's name, logo, colours, fonts, login page, links and announcement.
// The document lives in the `settings` table (key "branding"); uploaded images and the last versions live in their own tables.
// Everything an administrator can choose is structured data that is validated here. The one free-form field is custom CSS,
// which is off unless an administrator turns it on and is checked by sanitizeCss().

export const ASSET_KINDS=['mark','wordmark','favicon','login'] as const;
export type AssetKind=typeof ASSET_KINDS[number];
export const LINK_ICONS=['link','book','life-buoy','message-circle','shield','activity','server','globe','heart','mail','file-text','help-circle','users','star'] as const;
export const NAV_IDS=['overview','servers','nodes','resilience','templates','plugins','customers','activity','api','updates','settings','store','billing'] as const;
export const HISTORY_LIMIT=20;

export type BrandLink={label:string;url:string;icon:string;newTab:boolean};
export type Announcement={enabled:boolean;tone:'info'|'warn'|'bad';text:string;audience:'everyone'|'customers'|'admins';dismissible:boolean;startsAt:string|null;endsAt:string|null;id:string};
export type Branding={
 schemaVersion:1;revision:number;
 identity:{name:string;shortName:string;tagline:string;emailFromName:string;sourceUrl:string;showPoweredBy:boolean};
 theme:ThemeSpec;
 login:{welcome:string;background:'none'|'gradient'|'image';layout:'centered'|'split';footerLinks:BrandLink[]};
 navigation:{links:BrandLink[];labels:Record<string,string>};
 announcement:Announcement;
 email:{footer:string};
 advanced:{customCssEnabled:boolean;customCss:string};
 assets:Record<AssetKind,string|null>;
};

export function defaultBranding():Branding{
 return {
  schemaVersion:1,revision:0,
  identity:{name:process.env.BRAND_NAME?.trim()||'Fledge',shortName:'',tagline:'',emailFromName:'',sourceUrl:'',showPoweredBy:true},
  theme:defaultThemeSpec(),
  login:{welcome:'',background:'none',layout:'centered',footerLinks:[]},
  navigation:{links:[],labels:{}},
  announcement:{enabled:false,tone:'info',text:'',audience:'everyone',dismissible:true,startsAt:null,endsAt:null,id:''},
  email:{footer:''},
  advanced:{customCssEnabled:false,customCss:''},
  assets:{mark:null,wordmark:null,favicon:null,login:null},
 };
}

/* ------------------------------------------------------------------------------------------------ text and links */

// Control characters, zero-width characters and bidirectional overrides have no place in names or labels.
const BAD_CHARS=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/;
function text(v:unknown,name:string,{min=0,max,multiline=false}:{min?:number;max:number;multiline?:boolean}):string{
 if(typeof v!=='string')throw Error(`${name} must be text`);
 const s=v.normalize('NFC').replace(/\r\n?/g,'\n').trim();
 const len=[...s].length;
 if(len<min)throw Error(min===1?`${name} cannot be empty`:`${name} needs at least ${min} characters`);
 if(len>max)throw Error(`${name} can be at most ${max} characters`);
 if(BAD_CHARS.test(s)||(!multiline&&/[\n\t]/.test(s)))throw Error(`${name} contains characters that are not allowed`);
 return s;
}
function bool(v:unknown,name:string){if(typeof v!=='boolean')throw Error(`${name} must be on or off`);return v;}
function oneOf<T extends string>(v:unknown,name:string,values:readonly T[]):T{if(typeof v!=='string'||!(values as readonly string[]).includes(v))throw Error(`${name} must be one of ${values.join(', ')}`);return v as T;}
function url(v:unknown,name:string,protocols:string[]):string{
 const s=text(v,name,{min:1,max:500});
 let u:URL;try{u=new URL(s);}catch{throw Error(`${name} must be a full address like https://example.com`);}
 if(!protocols.includes(u.protocol))throw Error(`${name} must start with ${protocols.map(p=>p+(p.startsWith('http')?'//':'')).join(' or ')}`);
 if(u.username||u.password)throw Error(`${name} cannot contain a username or password`);
 return s;
}
function link(v:unknown,name:string,protocols:string[]):BrandLink{
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error(`${name} must be an object`);
 const r=v as any;
 return {label:text(r.label,`${name} label`,{min:1,max:40}),url:url(r.url,`${name} address`,protocols),icon:r.icon===undefined||r.icon===''?'link':oneOf(r.icon,`${name} icon`,LINK_ICONS),newTab:r.newTab===undefined?true:bool(r.newTab,`${name} “open in a new tab”`)};
}
function links(v:unknown,name:string,max:number,protocols:string[]):BrandLink[]{
 if(!Array.isArray(v))throw Error(`${name} must be a list`);
 if(v.length>max)throw Error(`${name} can have at most ${max} entries`);
 return v.map((x,i)=>link(x,`${name} ${i+1}`,protocols));
}
const isoOrNull=(v:unknown,name:string)=>{if(v===null||v===undefined||v==='')return null;if(typeof v!=='string'||Number.isNaN(Date.parse(v)))throw Error(`${name} must be a date and time`);return new Date(v).toISOString();};

/* ------------------------------------------------------------------------------------------------ custom CSS */

export const CSS_LIMIT=32*1024;
const DATA_URL_LIMIT=20*1024;
const CSS_REJECT:[RegExp,string][]=[
 [/@import/i,'@import loads other files'],[/@namespace/i,'@namespace is not allowed'],[/@font-face/i,'@font-face (custom fonts) is not available'],
 [/@(?:-moz-)?document/i,'@document is not allowed'],[/expression\s*\(/i,'expression() is not allowed'],[/behavior\s*:/i,'behavior is not allowed'],
 [/-moz-binding/i,'-moz-binding is not allowed'],[/(?:java|vb)script\s*:/i,'script URLs are not allowed'],[/<\/?\s*(?:style|script|link|iframe)/i,'HTML tags are not allowed in CSS'],
 [/<!--|--(?:!?)>/,'HTML comments are not allowed in CSS'],[/(?:^|[^a-z-])(?:-webkit-)?image-set\s*\(/i,'image-set() is not allowed'],[/(?:^|[^a-z-])(?:src|image|cross-fade|element)\s*\(/i,'This image function is not allowed'],
];
/** Resolves CSS escapes (\41, \a, \"), so a pattern cannot hide behind them. */
function unescapeCss(s:string):string{
 return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g,(_m,hex,ch)=>hex?String.fromCodePoint(Math.min(parseInt(hex,16)||0xFFFD,0x10FFFF)):ch);
}
/**
 * Checks administrator-written CSS. It returns the CSS to use (comments removed) and the problems found; with problems the
 * caller must not use it. Nothing that could contact another server is accepted: no @import, no remote url(), no fonts.
 */
export function sanitizeCss(input:string):{css:string;problems:string[]}{
 const problems:string[]=[];
 if(input.length>CSS_LIMIT)return {css:'',problems:[`Custom CSS can be at most ${CSS_LIMIT/1024} KB`]};
 if(BAD_CHARS.test(input.replace(/[\n\r\t]/g,'')))problems.push('The CSS contains control or invisible characters');
 // Comments are removed first; an unterminated one swallows the rest, as a browser would.
 const css=input.replace(/\/\*[\s\S]*?(?:\*\/|$)/g,' ').replace(/\r\n?/g,'\n');
 const plain=unescapeCss(css);
 for(const [re,why] of CSS_REJECT)if(re.test(plain))problems.push(why);
 // url(): only fragment references, our own images and small embedded images.
 for(const m of plain.matchAll(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)){
  const target=(m[1]??m[2]??m[3]??'').trim();
  const ok=target.startsWith('#')||/^\/branding\/(?:mark|wordmark|favicon|login)$/.test(target)
   ||(/^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i.test(target)&&target.length<=DATA_URL_LIMIT);
  if(!ok)problems.push(target.startsWith('data:')?`An embedded image is larger than ${DATA_URL_LIMIT/1024} KB`:'url() may only point to #fragments, /branding/ images or small embedded images');
 }
 // Balanced braces and parentheses outside strings, so a stray brace cannot leak into the rest of the page.
 let depth=0,paren=0,quote='';
 for(let i=0;i<css.length;i++){
  const c=css[i];
  if(quote){if(c==='\\')i++;else if(c===quote)quote='';else if(c==='\n')quote='';continue;}
  if(c==='"'||c==="'")quote=c;else if(c==='{')depth++;else if(c==='}'){depth--;if(depth<0)break;}else if(c==='(')paren++;else if(c===')'){paren--;if(paren<0)break;}
 }
 if(depth!==0||paren!==0)problems.push('The CSS has unbalanced braces or parentheses');
 return {css:css.trim(),problems:[...new Set(problems)]};
}

/* ------------------------------------------------------------------------------------------------ the document */

function validateSections(raw:any,onError:(section:string,e:Error)=>void,strict:boolean):Branding{
 const d=defaultBranding();
 const out:Branding={...d,revision:Number.isInteger(raw?.revision)&&raw.revision>=0?raw.revision:0};
 const run=<T>(section:string,fallback:T,fn:()=>T):T=>{
  // A section a newer or older version did not write is simply the default when reading.
  if(!strict&&section!=='assets'&&raw?.[section]===undefined)return fallback;
  try{return fn();}catch(e:any){onError(section,e);return fallback;}
 };
 const obj=(v:any,name:string)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error(`${name} must be an object`);return v;};
 out.identity=run('identity',d.identity,()=>{
  const r=obj(raw?.identity,'Identity');
  const name=text(r.name,'Panel name',{min:1,max:40});
  return {name,shortName:r.shortName===''||r.shortName===undefined?'':text(r.shortName,'Short name',{min:1,max:12}),tagline:text(r.tagline??'','Tagline',{max:120}),
   emailFromName:text(r.emailFromName??'','Email sender name',{max:60}),sourceUrl:r.sourceUrl===''||r.sourceUrl===undefined?'':url(r.sourceUrl,'Source code address',['https:','http:']),
   showPoweredBy:bool(r.showPoweredBy,'“Powered by” link')};
 });
 out.theme=run('theme',d.theme,()=>{
  const spec=sanitizeThemeSpec(raw?.theme);
  const checked=checkTheme(spec);
  if(checked.errors.length)throw Error(`Some colours are not readable enough: ${checked.errors.slice(0,3).join('; ')}`);
  return spec;
 });
 out.login=run('login',d.login,()=>{
  const r=obj(raw?.login,'Login page');
  return {welcome:text(r.welcome??'','Welcome text',{max:280,multiline:true}),background:oneOf(r.background,'Login background',['none','gradient','image'] as const),layout:oneOf(r.layout,'Login layout',['centered','split'] as const),
   footerLinks:links(r.footerLinks??[],'Login footer link',5,['https:','http:','mailto:','tel:'])};
 });
 out.navigation=run('navigation',d.navigation,()=>{
  const r=obj(raw?.navigation,'Navigation');
  const labelsIn=obj(r.labels??{},'Navigation labels'),labels:Record<string,string>={};
  for(const [k,v] of Object.entries(labelsIn)){
   if(!(NAV_IDS as readonly string[]).includes(k))throw Error(`“${k}” is not a navigation entry`);
   const label=text(v,`Label for ${k}`,{min:1,max:24});
   if(label)labels[k]=label;
  }
  return {links:links(r.links??[],'Sidebar link',8,['https:','http:','mailto:']),labels};
 });
 out.announcement=run('announcement',d.announcement,()=>{
  const r=obj(raw?.announcement,'Announcement');
  const startsAt=isoOrNull(r.startsAt,'Start'),endsAt=isoOrNull(r.endsAt,'End');
  if(startsAt&&endsAt&&Date.parse(endsAt)<=Date.parse(startsAt))throw Error('The announcement must end after it starts');
  const enabled=bool(r.enabled,'Announcement'),body=text(r.text??'','Announcement text',{max:400,multiline:true});
  if(enabled&&!body)throw Error('Write the announcement text, or turn the announcement off');
  return {enabled,tone:oneOf(r.tone,'Announcement tone',['info','warn','bad'] as const),text:body,audience:oneOf(r.audience,'Announcement audience',['everyone','customers','admins'] as const),dismissible:bool(r.dismissible,'Dismissible'),startsAt,endsAt,id:typeof r.id==='string'&&r.id.length<=64?r.id:''};
 });
 out.email=run('email',d.email,()=>({footer:text(obj(raw?.email,'Email').footer??'','Email footer',{max:300,multiline:true})}));
 out.advanced=run('advanced',d.advanced,()=>{
  const r=obj(raw?.advanced,'Advanced');
  const enabled=bool(r.customCssEnabled,'Custom CSS'),src=typeof r.customCss==='string'?r.customCss:'';
  if(typeof r.customCss!=='string')throw Error('Custom CSS must be text');
  const {css,problems}=sanitizeCss(src);
  if(problems.length&&(enabled||strict))throw Error(`Custom CSS: ${problems.join('; ')}`);
  return {customCssEnabled:enabled,customCss:problems.length?'':css};
 });
 out.assets=run('assets',d.assets,()=>{
  const r=obj(raw?.assets??{},'Images'),a:Record<AssetKind,string|null>={mark:null,wordmark:null,favicon:null,login:null};
  for(const k of ASSET_KINDS){const v=r[k];if(v===null||v===undefined)continue;if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw Error(`The ${k} image is not valid`);a[k]=v;}
  return a;
 });
 return out;
}

/** Strict: for saving. Throws 400 with a readable message for the first problem. */
export function validateBranding(raw:unknown):Branding{
 let first:Error|undefined;
 const doc=validateSections(raw,(section,e)=>{first??=e;},true);
 if(first)fail(400,first.message);
 return doc;
}
/** Lenient: for reading what is stored. A broken section falls back to its default so the panel always renders. */
export function readBranding(raw:unknown):{doc:Branding;warnings:string[]}{
 const warnings:string[]=[];
 const doc=validateSections(raw,(section,e)=>warnings.push(`${section}: ${e.message}. The default is used instead.`),false);
 return {doc,warnings};
}

export const brandingDisabled=()=>process.env.BRANDING_DISABLED==='true';

const memo=new WeakMap<object,{doc:Branding;warnings:string[]}>();
/** The effective document: defaults when branding is switched off or nothing has been saved. */
export async function loadBranding():Promise<{doc:Branding;warnings:string[];disabled:boolean}>{
 if(brandingDisabled())return {doc:defaultBranding(),warnings:[],disabled:true};
 const stored=(await settings()).branding as any;
 if(!stored||stored.schemaVersion!==1)return {doc:defaultBranding(),warnings:[],disabled:false};
 // settings() hands out the same object for a few seconds, so deriving and checking the theme happens once per change.
 let hit=memo.get(stored);
 if(!hit){hit=readBranding(stored);memo.set(stored,hit);}
 return {...hit,disabled:false};
}

/** Names used in text the server writes (emails, notifications, authenticator entries). */
export async function brand(){
 const {doc}=await loadBranding();
 const name=doc.identity.name,short=doc.identity.shortName||name;
 return {name,short,emailFromName:doc.identity.emailFromName,footer:doc.email.footer};
}
/** Colours and logo for HTML email (always the light palette: most mail clients are light). */
export async function emailPalette(){
 const {doc}=await loadBranding();
 const t=derivePalette(doc.theme.light,'light').tokens;
 const origin=(process.env.WEB_ORIGIN||'').replace(/\/$/,'');
 // A logo only helps when the panel is reachable from the outside.
 const kind=doc.assets.wordmark?'wordmark':doc.assets.mark?'mark':null;
 return {bg:t.bg,surface:t.surface,text:t.text,muted:t['text-2'],border:t.border,button:t.primary,buttonText:t['primary-text'],accent:t.accent,
  logo:kind&&/^https:\/\//.test(origin)?`${origin}/branding/${kind}`:null,name:doc.identity.name,footer:doc.email.footer};
}

/** "Name <addr>" when the configured sender has no display name of its own. */
export function senderWithName(from:string,displayName:string){
 if(!displayName||from.includes('<'))return from;
 return `"${displayName.replace(/["\\\r\n]/g,'')}" <${from}>`;
}

/* ------------------------------------------------------------------------------------------------ public projection */

const announcementActive=(a:Announcement,now=Date.now())=>a.enabled&&!!a.text&&(!a.startsAt||now>=Date.parse(a.startsAt))&&(!a.endsAt||now<Date.parse(a.endsAt));
const assetUrl=(doc:Branding,k:AssetKind)=>doc.assets[k]?`/branding/${k}?v=${doc.assets[k]!.slice(0,16)}`:null;

/** Page and accent colours of both modes, for the browser's address bar colour and the web app manifest. */
function themeColors(t:ThemeSpec){
 const d=derivePalette(t.dark,'dark').tokens,l=derivePalette(t.light,'light').tokens;
 return {dark:{bg:d.bg,accent:d.accent},light:{bg:l.bg,accent:l.accent}};
}

/** What anyone may see. Built from an explicit list of fields, so a new setting is private until it is added here. */
export function publicBranding(doc:Branding,disabled=false,version=''){
 const a=doc.announcement;
 return {
  revision:doc.revision,disabled,
  product:{name:'Fledge',version},
  identity:{name:doc.identity.name,shortName:doc.identity.shortName||doc.identity.name,tagline:doc.identity.tagline,showPoweredBy:doc.identity.showPoweredBy,sourceUrl:doc.identity.sourceUrl},
  theme:{mode:doc.theme.mode,allowUserMode:doc.theme.allowUserMode,font:doc.theme.font,motion:doc.theme.motion,css:themeCss(doc.theme),colors:themeColors(doc.theme)},
  customCss:doc.advanced.customCssEnabled?doc.advanced.customCss:'',
  images:{mark:assetUrl(doc,'mark'),wordmark:assetUrl(doc,'wordmark'),favicon:assetUrl(doc,'favicon')||assetUrl(doc,'mark'),login:assetUrl(doc,'login')},
  login:{welcome:doc.login.welcome,background:doc.login.background==='image'&&!doc.assets.login?'gradient':doc.login.background,layout:doc.login.layout,footerLinks:doc.login.footerLinks},
  navigation:doc.navigation,
  announcement:announcementActive(a)&&a.audience==='everyone'?{id:a.id,tone:a.tone,text:a.text,dismissible:a.dismissible,audience:a.audience}:null,
 };
}
export const PUBLIC_KEYS=['revision','disabled','product','identity','theme','customCss','images','login','navigation','announcement'];

/* ------------------------------------------------------------------------------------------------ images */

type Sniffed={mime:string;width:number|null;height:number|null};
const LIMITS:Record<AssetKind,{bytes:number;types:string[];maxW:number;maxH:number}>={
 mark:{bytes:512*1024,types:['image/png','image/webp','image/jpeg','image/svg+xml'],maxW:1024,maxH:1024},
 wordmark:{bytes:512*1024,types:['image/png','image/webp','image/jpeg','image/svg+xml'],maxW:2048,maxH:512},
 favicon:{bytes:128*1024,types:['image/png','image/x-icon','image/svg+xml','image/webp'],maxW:512,maxH:512},
 login:{bytes:2*1024*1024,types:['image/jpeg','image/webp','image/png'],maxW:4096,maxH:4096},
};
export const assetLimit=(k:AssetKind)=>LIMITS[k].bytes;

/** Reads the type and size from the file's own header (no image library, no decoding). */
export function sniffImage(buf:Buffer):Sniffed|null{
 try{return sniffRaster(buf)||svgCheck(buf);}catch(e:any){if(e instanceof SvgError)throw e;return null;}
}
class SvgError extends Error{}
function sniffRaster(buf:Buffer):Sniffed|null{
 if(buf.length>=24&&buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))&&buf.toString('ascii',12,16)==='IHDR')return {mime:'image/png',width:buf.readUInt32BE(16),height:buf.readUInt32BE(20)};
 if(buf.length>=3&&buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff){
  let i=2;
  while(i+9<buf.length){
   if(buf[i]!==0xff){i++;continue;}
   const m=buf[i+1];
   if(m===0xff){i++;continue;}
   if(m>=0xc0&&m<=0xcf&&![0xc4,0xc8,0xcc].includes(m))return {mime:'image/jpeg',height:buf.readUInt16BE(i+5),width:buf.readUInt16BE(i+7)};
   if(m===0xd8||m===0x01||(m>=0xd0&&m<=0xd7)){i+=2;continue;}
   i+=2+buf.readUInt16BE(i+2);
  }
  return null;
 }
 if(buf.length>=30&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP'){
  const kind=buf.toString('ascii',12,16);
  if(kind==='VP8X')return {mime:'image/webp',width:1+buf.readUIntLE(24,3),height:1+buf.readUIntLE(27,3)};
  if(kind==='VP8L'&&buf[20]===0x2f){const b=buf.readUInt32LE(21);return {mime:'image/webp',width:1+(b&0x3fff),height:1+((b>>14)&0x3fff)};}
  if(kind==='VP8 '&&buf[23]===0x9d&&buf[24]===0x01&&buf[25]===0x2a)return {mime:'image/webp',width:buf.readUInt16LE(26)&0x3fff,height:buf.readUInt16LE(28)&0x3fff};
  return null;
 }
 if(buf.length>=22&&buf.readUInt16LE(0)===0&&buf.readUInt16LE(2)===1&&buf.readUInt16LE(4)>0&&buf.readUInt16LE(4)<=64)return {mime:'image/x-icon',width:buf[6]||256,height:buf[7]||256};
 return null;
}
const SVG_REJECT:[RegExp,string][]=[
 [/<\s*script/i,'scripts'],[/<\s*foreignObject/i,'foreignObject'],[/<\s*(?:iframe|object|embed|audio|video|link|style|animate|set|use\b[^>]*\b(?:href|xlink:href)\s*=\s*["'](?!#))/i,'embedded content or styles'],
 [/\bon[a-z]+\s*=/i,'event handlers'],[/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i,'a DOCTYPE or entities'],[/(?:java|vb)script\s*:/i,'script URLs'],
 [/(?:xlink:)?href\s*=\s*["'](?!#)/i,'external references'],[/url\s*\(\s*(?!(?:["']|&quot;|&apos;)?#)/i,'external references'],
];
function svgCheck(buf:Buffer):Sniffed|null{
 if(buf.length>256*1024)return null;
 const s=buf.toString('utf8').replace(/^\uFEFF/,'');
 if(s.includes('\u0000'))return null;
 if(!/<svg[\s>]/i.test(s))return null;
 for(const [re,what] of SVG_REJECT)if(re.test(s))throw new SvgError(`The SVG contains ${what}, which is not allowed. Export a plain SVG (shapes and paths only).`);
 const head=s.replace(/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/,'');
 if(!/^<svg[\s>]/i.test(head)||!/<\/svg>\s*$/i.test(head))return null;
 return {mime:'image/svg+xml',width:null,height:null};
}
/** Validates an upload for a slot. Returns what to store. */
export function checkAsset(kind:AssetKind,buf:Buffer){
 const lim=LIMITS[kind];
 if(!buf.length)fail(400,'The file is empty');
 if(buf.length>lim.bytes)fail(413,`The ${kind==='login'?'background':kind==='favicon'?'favicon':'logo'} can be at most ${lim.bytes/1024} KB`);
 let sniffed:Sniffed|null;
 try{sniffed=sniffImage(buf);}catch(e:any){return fail(400,e.message);}
 if(!sniffed)return fail(400,'This is not a PNG, JPEG, WebP, ICO or SVG image');
 if(!lim.types.includes(sniffed.mime))return fail(400,`${kind==='login'?'The login background':kind==='favicon'?'The favicon':'A logo'} can be ${lim.types.map(t=>t.replace('image/','').replace('svg+xml','SVG').replace('x-icon','ICO').toUpperCase()).join(', ')}`);
 if(sniffed.width!==null&&(sniffed.width<1||sniffed.height!<1||sniffed.width>lim.maxW||sniffed.height!>lim.maxH))return fail(400,`The image is ${sniffed.width}×${sniffed.height}px; the largest allowed is ${lim.maxW}×${lim.maxH}px`);
 return {...sniffed,sha256:createHash('sha256').update(buf).digest('hex'),size:buf.length};
}

/* ------------------------------------------------------------------------------------------------ storage and routes */

async function referencedBlobs(doc:Branding){
 for(const k of ASSET_KINDS){
  const sha=doc.assets[k];
  if(!sha)continue;
  const r=await pool.query('SELECT 1 FROM branding_blobs WHERE sha256=$1 AND kind=$2',[sha,k]);
  if(!r.rowCount)fail(400,`The ${k} image is no longer stored. Upload it again.`);
 }
}

/** Saves a new version in one transaction: settings row, history row, trimming. A stale base revision is a conflict. */
export async function commitBranding(doc:Branding,actor:string,reason:string,baseRevision?:number){
 await referencedBlobs(doc);
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(727201)');
  const cur=(await c.query("SELECT value FROM settings WHERE key='branding'")).rows[0]?.value as any;
  const currentRevision=Number.isInteger(cur?.revision)?cur.revision:0;
  if(baseRevision!==undefined&&baseRevision!==currentRevision){
   await c.query('ROLLBACK');
   throw Object.assign(new Error('Someone else changed the appearance while you were editing. Reload to see their version.'),{statusCode:409,error:'conflict',details:{revision:currentRevision}});
  }
  const next={...doc,revision:currentRevision+1};
  await c.query("INSERT INTO settings(key,value,secret,updated_by) VALUES('branding',$1,NULL,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()",[JSON.stringify(next),actor]);
  await c.query('INSERT INTO branding_history(revision,by,reason,value) VALUES($1,$2,$3,$4)',[next.revision,actor,reason.slice(0,120),JSON.stringify(next)]);
  await c.query('DELETE FROM branding_history WHERE id NOT IN (SELECT id FROM branding_history ORDER BY id DESC LIMIT $1)',[HISTORY_LIMIT]);
  await c.query('COMMIT');
  invalidateSettings();
  return next;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}

/** Removes uploaded images nobody references any more (not the current version, not any kept version) after a day. */
export async function sweepBranding(){
 const keep=new Set<string>();
 const docs=[(await settings()).branding as any,...(await pool.query('SELECT value FROM branding_history')).rows.map(r=>r.value)];
 for(const d of docs)for(const sha of Object.values(d?.assets||{}))if(typeof sha==='string')keep.add(sha);
 await pool.query("DELETE FROM branding_blobs WHERE created_at<now()-interval '1 day' AND NOT (sha256=ANY($1::text[]))",[[...keep]]);
}

// jsonb does not keep the order of object keys, so documents are compared with sorted keys.
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([p],[q])=>p.localeCompare(q))):x);
const describe=(a:Branding,b:Branding)=>{
 const parts:string[]=[];
 const diff=(key:keyof Branding,label:string)=>{if(stable(a[key])!==stable(b[key]))parts.push(label);};
 diff('identity','identity');diff('theme','colours and type');diff('login','login page');diff('navigation','navigation');diff('announcement','announcement');
 diff('email','email');diff('advanced','custom CSS');diff('assets','images');
 return parts;
};

const panelVersion=()=>process.env.APP_VERSION||'';

export function brandingRoutes(app:FastifyInstance){
 const guard=(req:any)=>{admin(req);if(req.actor?.tokenScopes)fail(403,'Appearance can only be changed from a signed-in browser session');if(brandingDisabled())fail(409,'Appearance is switched off on this server (BRANDING_DISABLED). Remove the setting and restart the API to change it.');};

 app.get('/api/branding',async(_req,reply)=>{
  const {doc,disabled}=await loadBranding();
  const body=publicBranding(doc,disabled,panelVersion());
  reply.header('cache-control','public, max-age=15, stale-while-revalidate=120').header('etag',`"b${doc.revision}${disabled?'d':''}-${panelVersion()}"`);
  return body;
 });

 app.get('/api/branding/announcement',async(req)=>{
  const {doc}=await loadBranding(),a=doc.announcement;
  const mine=announcementActive(a)&&(a.audience==='everyone'||(a.audience==='admins')===(req.actor!.role==='admin'));
  return mine?{id:a.id,tone:a.tone,text:a.text,dismissible:a.dismissible,audience:a.audience}:null;
 });

 app.get('/api/branding/assets/:kind',async(req,reply)=>{
  const kind=(req.params as any).kind as AssetKind;
  if(!(ASSET_KINDS as readonly string[]).includes(kind))fail(404,'Unknown image');
  const {doc}=await loadBranding(),sha=doc.assets[kind];
  if(!sha)return fail(404,'No custom image');
  const row=(await pool.query('SELECT mime,bytes FROM branding_blobs WHERE sha256=$1 AND kind=$2',[sha,kind])).rows[0];
  if(!row)fail(404,'No custom image');
  const v=String((req.query as any)?.v||'');
  reply.header('content-type',row.mime).header('etag',`"${sha}"`).header('content-disposition','inline')
   .header('cache-control',v&&sha.startsWith(v)?'public, max-age=31536000, immutable':'public, max-age=60')
   .header('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'; sandbox").header('cross-origin-resource-policy','cross-origin');
  return reply.send(row.bytes);
 });

 // Admin: the whole document with history and warnings.
 app.get('/api/branding/admin',async(req)=>{
  admin(req);
  const {doc,warnings,disabled}=await loadBranding();
  const history=(await pool.query('SELECT h.id,h.revision,h.at,h.reason,u.email AS by FROM branding_history h LEFT JOIN users u ON u.id=h.by ORDER BY h.id DESC')).rows;
  return {branding:doc,warnings,disabled,history,limits:{css:CSS_LIMIT,assets:Object.fromEntries(ASSET_KINDS.map(k=>[k,{bytes:LIMITS[k].bytes,types:LIMITS[k].types,maxWidth:LIMITS[k].maxW,maxHeight:LIMITS[k].maxH}]))}};
 });

 // Dry run for the editor: derived colours, contrast and the sanitised CSS, nothing saved.
 app.post('/api/branding/validate',async(req)=>{
  admin(req);
  const body=req.body as any;
  const doc=validateBranding({...(body?.branding||body),assets:(body?.branding||body)?.assets??{}});
  const report=checkTheme(doc.theme);
  return {ok:true,warnings:report.warnings,dark:{tokens:report.dark.tokens,pairs:report.dark.pairs},light:{tokens:report.light.tokens,pairs:report.light.pairs},css:themeCss(doc.theme),customCss:doc.advanced.customCssEnabled?doc.advanced.customCss:''};
 });

 app.put('/api/branding',{config:{rateLimit:{max:60,timeWindow:'1 hour'}}},async(req)=>{
  guard(req);
  const body=req.body as any;
  if(!body||typeof body!=='object')fail(400,'Expected an object');
  const incoming=validateBranding(body.branding);
  const cur=(await loadBranding()).doc;
  // A new announcement id whenever the message changes, so an earlier dismissal does not hide the new text.
  const a=incoming.announcement,b=cur.announcement;
  if(stable({...a,id:''})!==stable({...b,id:''}))a.id=randomUUID().slice(0,12);else a.id=b.id||a.id;
  const parts=describe(cur,incoming);
  if(!parts.length&&incoming.revision===cur.revision)return {branding:cur,warnings:[]};
  const saved=await commitBranding(incoming,req.actor!.id,String(body.reason||'').trim()||`Changed ${parts.join(', ')||'settings'}`,Number.isInteger(body.baseRevision)?body.baseRevision:cur.revision);
  await audit(req.actor!.id,'branding.update','branding','branding',{changed:parts,revision:saved.revision,css:saved.advanced.customCssEnabled?{bytes:saved.advanced.customCss.length,sha:createHash('sha256').update(saved.advanced.customCss).digest('hex').slice(0,12)}:null});
  return {branding:saved,warnings:checkTheme(saved.theme).warnings};
 });

 app.post('/api/branding/assets',{config:{rateLimit:{max:60,timeWindow:'1 hour'}}},async(req)=>{
  guard(req);
  const part=await req.file({limits:{fileSize:2*1024*1024+1,files:1}});
  if(!part)fail(400,'Missing file');
  const kind=String((part!.fields?.kind as any)?.value||'');
  if(!(ASSET_KINDS as readonly string[]).includes(kind))fail(400,'Choose which image this is (mark, wordmark, favicon or login)');
  let data:Buffer;
  try{data=await part!.toBuffer();}catch{return fail(413,'The file is too large');}
  if(part!.file.truncated)fail(413,'The file is too large');
  const info=checkAsset(kind as AssetKind,data);
  await pool.query('INSERT INTO branding_blobs(sha256,kind,mime,bytes,width,height) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sha256,kind) DO UPDATE SET created_at=now()',[info.sha256,kind,info.mime,data,info.width,info.height]);
  await audit(req.actor!.id,'branding.asset.upload','branding',kind,{sha:info.sha256.slice(0,12),mime:info.mime,bytes:info.size});
  return {kind,sha256:info.sha256,mime:info.mime,width:info.width,height:info.height,size:info.size};
 });

 // Preview of an uploaded but not yet saved image, for the editor.
 app.get('/api/branding/blobs/:kind/:sha',async(req,reply)=>{
  admin(req);
  const {kind,sha}=req.params as any;
  const row=(await pool.query('SELECT mime,bytes FROM branding_blobs WHERE sha256=$1 AND kind=$2',[String(sha),String(kind)])).rows[0];
  if(!row)fail(404,'Image not found');
  reply.header('content-type',row.mime).header('cache-control','private, max-age=300').header('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'; sandbox").header('cross-origin-resource-policy','cross-origin');
  return reply.send(row.bytes);
 });

 app.get('/api/branding/history/:id',async(req)=>{
  admin(req);
  const row=(await pool.query('SELECT h.id,h.revision,h.at,h.reason,h.value FROM branding_history h WHERE id=$1',[Number((req.params as any).id)||0])).rows[0];
  if(!row)fail(404,'Version not found');
  return row;
 });

 app.post('/api/branding/history/:id/restore',{config:{rateLimit:{max:30,timeWindow:'1 hour'}}},async(req)=>{
  guard(req);
  const row=(await pool.query('SELECT revision,value FROM branding_history WHERE id=$1',[Number((req.params as any).id)||0])).rows[0];
  if(!row)fail(404,'Version not found');
  const cur=(await loadBranding()).doc;
  const {doc}=readBranding(row.value);
  const saved=await commitBranding({...doc,announcement:{...doc.announcement,id:randomUUID().slice(0,12)}},req.actor!.id,`Restored version ${row.revision}`,cur.revision);
  await audit(req.actor!.id,'branding.restore','branding','branding',{from:row.revision,revision:saved.revision});
  return {branding:saved,warnings:[]};
 });

 app.post('/api/branding/reset',{config:{rateLimit:{max:30,timeWindow:'1 hour'}}},async(req)=>{
  guard(req);
  const cur=(await loadBranding()).doc;
  const saved=await commitBranding(defaultBranding(),req.actor!.id,'Reset to the Fledge look',cur.revision);
  await audit(req.actor!.id,'branding.reset','branding','branding',{revision:saved.revision});
  return {branding:saved,warnings:[]};
 });

 app.get('/api/branding/export',async(req,reply)=>{
  admin(req);
  const {doc}=await loadBranding();
  const images:Record<string,{mime:string;data:string}>={};
  for(const k of ASSET_KINDS){
   const sha=doc.assets[k];
   if(!sha)continue;
   const row=(await pool.query('SELECT mime,bytes FROM branding_blobs WHERE sha256=$1 AND kind=$2',[sha,k])).rows[0];
   if(row)images[k]={mime:row.mime,data:row.bytes.toString('base64')};
  }
  const {revision:_r,assets:_a,...rest}=doc;
  reply.header('content-disposition','attachment; filename="fledge-theme.json"');
  return {format:'fledge-theme',formatVersion:1,exportedAt:new Date().toISOString(),fledgeVersion:panelVersion(),branding:rest,images};
 });

 // Import never saves: it stores the images and returns a document for the editor to review and save.
 app.post('/api/branding/import',{config:{rateLimit:{max:30,timeWindow:'1 hour'}}},async(req)=>{
  guard(req);
  const b=req.body as any;
  if(!b||b.format!=='fledge-theme'||b.formatVersion!==1||!b.branding||typeof b.branding!=='object')fail(400,'This is not a Fledge theme file (format "fledge-theme", version 1)');
  const assets:Record<string,string|null>={mark:null,wordmark:null,favicon:null,login:null};
  const images=b.images&&typeof b.images==='object'?b.images:{};
  let bytes=0;
  for(const k of ASSET_KINDS){
   const img=images[k];
   if(!img)continue;
   if(typeof img.data!=='string')fail(400,`The ${k} image is not valid`);
   const buf=Buffer.from(img.data,'base64');
   bytes+=buf.length;
   if(bytes>3*1024*1024)fail(413,'The theme file is too large');
   const info=checkAsset(k,buf);
   await pool.query('INSERT INTO branding_blobs(sha256,kind,mime,bytes,width,height) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sha256,kind) DO UPDATE SET created_at=now()',[info.sha256,k,info.mime,buf,info.width,info.height]);
   assets[k]=info.sha256;
  }
  const doc=validateBranding({...b.branding,assets,revision:(await loadBranding()).doc.revision});
  const cur=(await loadBranding()).doc;
  doc.announcement.id=cur.announcement.id;
  return {branding:doc,changed:describe(cur,doc),warnings:checkTheme(doc.theme).warnings,fromVersion:typeof b.fledgeVersion==='string'?b.fledgeVersion.slice(0,20):null};
 });
}
