import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,txt,audit,withAdvisoryLock,WEB_ORIGIN} from './core.js';
import {settings} from './settings.js';
import {mailerReady,sendMail,esc} from './mailer.js';
import {emailPalette} from './branding.js';
import {TEMPLATES,COMMON_VARS,templateById,type TemplateDef} from './email-defaults.js';

// Email v2: editable templates, an outbox that retries, and a delivery log.
// Callers say WHICH template and WITH WHAT values; this module renders (escaping everything),
// queues, sends with backoff and records what happened. Nothing here evaluates code.

type Vars=Record<string,string|number|null|undefined>;
type Override={subject:string;text_body:string;html_body:string|null;enabled:boolean};

// --- Rendering ----------------------------------------------------------------------------
const IF=/\{\{#if ([A-Za-z][A-Za-z0-9]*)\}\}([\s\S]*?)\{\{\/if\}\}/g;
const VAR=/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/** Fills a template. `escape` is applied to every value (HTML-escape for the HTML part, identity for text). */
export function fill(src:string,vars:Vars,escape:(s:string)=>string=s=>s):string{
 const get=(k:string)=>{const x=vars[k];return x===undefined||x===null?'':String(x);};
 return src.replace(IF,(_,k,inner)=>get(k).trim()?inner:'').replace(VAR,(_,k)=>escape(get(k)));
}
/** Every variable name a template mentions. */
export function mentioned(src:string):string[]{
 const out=new Set<string>();
 for(const m of src.matchAll(/\{\{#if ([A-Za-z][A-Za-z0-9]*)\}\}/g))out.add(m[1]);
 for(const m of src.matchAll(VAR))out.add(m[1]);
 return [...out];
}
/** Problems with an edited template: unknown variables, stray braces, size. */
export function lintTemplate(def:TemplateDef,subject:string,body:string,html?:string|null):string[]{
 const problems:string[]=[],known=new Set([...def.vars,...COMMON_VARS].map(v=>v.name));
 if(!subject.trim())problems.push('The subject cannot be empty');
 if(subject.length>200)problems.push('The subject is too long (200 characters at most)');
 if(!body.trim())problems.push('The message cannot be empty');
 if(body.length>8000)problems.push('The message is too long (8000 characters at most)');
 if((html||'').length>40000)problems.push('The HTML is too long (40000 characters at most)');
 for(const part of [subject,body,html||'']){
  for(const name of mentioned(part))if(!known.has(name))problems.push(`Unknown variable “${name}”`);
  const opens=(part.match(/\{\{#if /g)||[]).length,closes=(part.match(/\{\{\/if\}\}/g)||[]).length;
  if(opens!==closes)problems.push('Every {{#if …}} needs a matching {{/if}}');
 }
 if(def.critical&&def.vars.some(v=>v.name==='link')&&!/\{\{link\}\}/.test(body)&&!(html||'').includes('{{link}}'))problems.push('This email must contain {{link}}, otherwise the recipient cannot use it');
 return [...new Set(problems)];
}

type Block={kind:'p';text:string}|{kind:'list';items:string[]}|{kind:'button';label:string;url:string};
function parseBody(text:string):Block[]{
 const blocks:Block[]=[];
 for(const chunk of text.replace(/\r\n/g,'\n').split(/\n{2,}/)){
  const lines=chunk.split('\n').map(l=>l.trim()).filter(Boolean);
  if(!lines.length)continue;
  const btn=/^\[button:\s*(.+?)\s*\|\s*(.+?)\s*\]$/.exec(lines[0]);
  if(lines.length===1&&btn){blocks.push({kind:'button',label:btn[1],url:btn[2]});continue;}
  if(lines.every(l=>l.startsWith('- '))){blocks.push({kind:'list',items:lines.map(l=>l.slice(2))});continue;}
  blocks.push({kind:'p',text:lines.join('\n')});
 }
 return blocks;
}
const safeUrl=(u:string)=>/^(https?:\/\/|mailto:)/i.test(u)?u:'';
const bold=(s:string)=>s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');

export type Rendered={subject:string;text:string;html:string};
export async function render(def:TemplateDef,vars:Vars,over?:Partial<Override>|null):Promise<Rendered>{
 const all=await withCommon(vars);
 const subject=fill(over?.subject??def.subject,all).replace(/[\r\n]+/g,' ').trim().slice(0,200);
 const source=over?.text_body??def.body;
 const pal=await emailPalette();
 // Text version
 const textBlocks=parseBody(fill(source,all));
 const text=textBlocks.map(b=>b.kind==='button'?`${b.label}: ${b.url}`:b.kind==='list'?b.items.map(i=>`- ${i.replace(/\*\*/g,'')}`).join('\n'):b.text.replace(/\*\*/g,'')).join('\n\n');
 const footerText=[all.companyName,all.companyAddress,pal.footer].filter(Boolean).join('\n');
 const fullText=footerText?`${text}\n\n--\n${footerText}\n`:`${text}\n`;
 // HTML version: a custom HTML replaces the generated layout; its variables are escaped.
 if(over?.html_body){
  const html=fill(over.html_body,all,esc);
  return {subject,text:fullText,html};
 }
 const body=parseBody(fill(source,all,esc)).map(b=>{
  if(b.kind==='button'){const u=safeUrl(b.url.replace(/&amp;/g,'&'));return u?`<p style="margin:24px 0"><a href="${esc(u)}" style="background:${pal.button};color:${pal.buttonText};text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${b.label}</a></p>`:'';}
  if(b.kind==='list')return `<ul style="margin:0 0 16px;padding-left:20px">${b.items.map(i=>`<li style="margin:4px 0">${bold(i)}</li>`).join('')}</ul>`;
  return `<p style="margin:0 0 16px;line-height:1.55">${bold(b.text).replace(/\n/g,'<br>')}</p>`;
 }).join('');
 const brandHead=pal.logo?`<img src="${esc(pal.logo)}" alt="${esc(pal.name)}" style="max-height:36px;max-width:200px">`:`<span style="font-size:20px;font-weight:700;color:${pal.text}">${esc(pal.name)}</span>`;
 const foot=[all.companyName,all.companyAddress,pal.footer].filter(Boolean).map(x=>esc(String(x)).replace(/\n/g,'<br>')).join('<br>');
 const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:${pal.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${pal.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${pal.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td style="padding:0 4px 16px">${brandHead}</td></tr>
<tr><td style="background:${pal.surface};border:1px solid ${pal.border};border-radius:12px;padding:28px 28px 12px;font-size:15px;color:${pal.text}">${body}</td></tr>
<tr><td style="padding:16px 8px;font-size:12px;color:${pal.muted};line-height:1.5">${foot}</td></tr></table></td></tr></table></body></html>`;
 return {subject,text:fullText,html};
}

async function withCommon(vars:Vars):Promise<Vars>{
 const st=(await settings()).store;
 const {name}=await emailPalette();
 return {brand:name,panelUrl:WEB_ORIGIN.replace(/\/$/,''),supportEmail:st.companyEmail,companyName:st.companyName,companyAddress:st.companyAddress,year:new Date().getUTCFullYear(),...vars};
}

// --- Overrides (what the administrator edited) ---------------------------------------------------
let overrideCache:{at:number;map:Map<string,Override>}|undefined;
async function overrides():Promise<Map<string,Override>>{
 if(overrideCache&&Date.now()-overrideCache.at<5000)return overrideCache.map;
 const map=new Map<string,Override>();
 try{for(const r of (await pool.query('SELECT id,subject,text_body,html_body,enabled FROM email_templates')).rows)map.set(r.id,r);}catch{/* table not there yet */}
 overrideCache={at:Date.now(),map};return map;
}
const clearOverrides=()=>{overrideCache=undefined;};

// --- Queueing and sending ------------------------------------------------------------------------
export type SendResult={status:'sent'|'queued'|'skipped'|'failed';id?:number;reason?:string};
export async function sendTemplate(id:string,to:string,vars:Vars={},opts:{userId?:string|null;dedupeKey?:string;inline?:boolean}={}):Promise<SendResult>{
 const def=templateById(id);
 if(!def)throw new Error(`Unknown email template ${id}`);
 const over=(await overrides()).get(id)||null;
 if(over&&!over.enabled&&!def.critical)return {status:'skipped',reason:'disabled'};
 if(!(await mailerReady()))return {status:'skipped',reason:'email-not-configured'};
 const r=await render(def,{email:to,...vars},over);
 const ins=await pool.query(`INSERT INTO email_outbox(to_addr,template,user_id,subject,text_body,html_body,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
  [to,id,opts.userId||null,r.subject,r.text,r.html,opts.dedupeKey||null]);
 if(!ins.rowCount)return {status:'skipped',reason:'duplicate'};
 const id2=Number(ins.rows[0].id);
 // Mail goes out straight away; the outbox only matters when that fails (it is then retried with backoff).
 if(opts.inline){
  const ok=await attempt(id2);
  return {status:ok?'sent':'queued',id:id2};
 }
 void attempt(id2).catch(()=>{});
 return {status:'queued',id:id2};
}

/** Claims one queued message so that neither the sweeper nor another request sends it twice, then sends it. */
async function attempt(id:number):Promise<boolean>{
 const row=(await pool.query("UPDATE email_outbox SET status='sending',next_attempt_at=now() WHERE id=$1 AND status='queued' RETURNING *",[id])).rows[0];
 return row?deliver({...row,attempts:Number(row.attempts)}):false;
}

/** Sends the mail for a template to the administrators' copy address (if set) and returns what was queued. */
export async function sendToAdmins(id:string,vars:Vars={},dedupeKey?:string){
 const st=(await settings());
 const to=st.email.adminBcc||st.store.companyEmail;
 if(!to)return {status:'skipped' as const,reason:'no-admin-address'};
 return sendTemplate(id,to,vars,{dedupeKey});
}

const backoff=(attempt:number)=>Math.min(6*3600,60*2**Math.min(attempt,10))*(0.85+Math.random()*0.3);

async function deliver(row:any):Promise<boolean>{
 const cfg=(await settings()).email;
 try{
  const bcc=templateById(row.template)?.bccAdmin&&cfg.adminBcc&&cfg.adminBcc!==row.to_addr?cfg.adminBcc:undefined;
  await sendMail({to:row.to_addr,subject:row.subject,text:row.text_body||'',html:row.html_body||undefined,raw:true,bcc});
  await pool.query("UPDATE email_outbox SET status='sent',sent_at=now(),last_error=NULL,attempts=attempts+1 WHERE id=$1",[row.id]);
  return true;
 }catch(e:any){
  const attempts=Number(row.attempts)+1,final=attempts>=cfg.maxAttempts;
  await pool.query("UPDATE email_outbox SET status=$2,attempts=$3,last_error=$4,next_attempt_at=now()+make_interval(secs=>$5) WHERE id=$1",
   [row.id,final?'failed':'queued',attempts,String(e?.message||'error').slice(0,300),final?0:backoff(attempts)]);
  return false;
 }
}

/** Sends what is due, within the per-minute allowance; tidies up old rows. Safe to call from several API replicas. */
export async function sweepOutbox(){
 await withAdvisoryLock(727301,async()=>{
  const cfg=(await settings()).email;
  await pool.query("UPDATE email_outbox SET status='queued' WHERE status='sending' AND next_attempt_at<now()-interval '5 minutes'");
  if(await mailerReady()){
   const sentLastMinute=Number((await pool.query("SELECT count(*) n FROM email_outbox WHERE status='sent' AND sent_at>now()-interval '1 minute'")).rows[0].n);
   const room=Math.max(0,Math.min(25,cfg.perMinute-sentLastMinute));
   if(room>0){
    const claimed=(await pool.query("UPDATE email_outbox SET status='sending',next_attempt_at=now() WHERE id IN (SELECT id FROM email_outbox WHERE status='queued' AND next_attempt_at<=now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *",[room])).rows;
    for(const row of claimed)await deliver({...row,attempts:Number(row.attempts)});
   }
  }
  // Mail that has waited a week without a working mail server is given up on.
  await pool.query("UPDATE email_outbox SET status='failed',last_error=COALESCE(last_error,'Email was not set up for 7 days') WHERE status='queued' AND created_at<now()-interval '7 days'");
  await pool.query("UPDATE email_outbox SET text_body=NULL,html_body=NULL WHERE status IN ('sent','failed') AND text_body IS NOT NULL AND created_at<now()-interval '7 days'");
  await pool.query("DELETE FROM email_outbox WHERE created_at<now()-make_interval(days=>$1)",[cfg.logDays]);
 });
}

// --- Routes --------------------------------------------------------------------------------------
const sampleVars=(def:TemplateDef):Vars=>Object.fromEntries([...COMMON_VARS,...def.vars].map(v=>[v.name,v.sample]));

export function emailRoutes(app:FastifyInstance){
 app.get('/api/email/templates',async(req)=>{
  admin(req);
  const over=await overrides();
  return TEMPLATES.map(t=>{const o=over.get(t.id);return {id:t.id,label:t.label,group:t.group,audience:t.audience,critical:t.critical,description:t.description,vars:[...t.vars,...COMMON_VARS],
   subject:o?.subject??t.subject,body:o?.text_body??t.body,html:o?.html_body??null,enabled:o?o.enabled:true,customized:!!o,defaultSubject:t.subject,defaultBody:t.body};});
 });
 app.put('/api/email/templates/:id',async(req)=>{
  admin(req);
  const def=templateById((req.params as any).id);
  if(!def)fail(404,'Unknown template');
  const b=req.body as any;
  const subject=txt(b?.subject,200),body=txt(b?.body,8000),html=typeof b?.html==='string'&&b.html.trim()?String(b.html).slice(0,40000):null;
  const problems=lintTemplate(def!,subject,body,html);
  if(problems.length)fail(400,problems.join('; '));
  const enabled=def!.critical?true:b?.enabled!==false;
  await pool.query('INSERT INTO email_templates(id,subject,text_body,html_body,enabled,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET subject=EXCLUDED.subject,text_body=EXCLUDED.text_body,html_body=EXCLUDED.html_body,enabled=EXCLUDED.enabled,updated_at=now(),updated_by=EXCLUDED.updated_by',[def!.id,subject,body,html,enabled,req.actor!.id]);
  clearOverrides();
  await audit(req.actor!.id,'email.template.update','email_template',def!.id);
  return {ok:true};
 });
 app.delete('/api/email/templates/:id',async(req)=>{
  admin(req);
  const def=templateById((req.params as any).id);
  if(!def)fail(404,'Unknown template');
  await pool.query('DELETE FROM email_templates WHERE id=$1',[def!.id]);
  clearOverrides();
  await audit(req.actor!.id,'email.template.reset','email_template',def!.id);
  return {ok:true};
 });
 // Shows exactly what a draft would look like, with sample values, without saving it.
 app.post('/api/email/templates/:id/preview',async(req)=>{
  admin(req);
  const def=templateById((req.params as any).id);
  if(!def)fail(404,'Unknown template');
  const b=req.body as any;
  const subject=typeof b?.subject==='string'?b.subject.slice(0,200):def!.subject,body=typeof b?.body==='string'?b.body.slice(0,8000):def!.body,html=typeof b?.html==='string'&&b.html.trim()?b.html.slice(0,40000):null;
  const problems=lintTemplate(def!,subject,body,html);
  const r=await render(def!,sampleVars(def!),{subject,text_body:body,html_body:html});
  return {...r,problems};
 });
 app.post('/api/email/templates/:id/test',async(req)=>{
  admin(req);
  const def=templateById((req.params as any).id);
  if(!def)fail(404,'Unknown template');
  if(!(await mailerReady()))fail(409,'Email is not set up. Turn it on in Settings, Email first.');
  const over=(await overrides()).get(def!.id)||null;
  const r=await render(def!,{...sampleVars(def!),email:req.actor!.email},over);
  await sendMail({to:req.actor!.email,subject:`[Test] ${r.subject}`,text:r.text,html:r.html,raw:true});
  return {ok:true,to:req.actor!.email};
 });
 app.get('/api/email/outbox',async(req)=>{
  admin(req);
  const q=req.query as any,limit=Math.min(200,Math.max(1,Number(q?.limit)||50)),offset=Math.max(0,Number(q?.offset)||0);
  const status=['queued','sending','sent','failed'].includes(q?.status)?q.status:null;
  const rows=(await pool.query('SELECT id,to_addr AS "to",template,subject,status,attempts,last_error AS "lastError",created_at AS "createdAt",sent_at AS "sentAt",next_attempt_at AS "nextAttemptAt" FROM email_outbox WHERE ($1::text IS NULL OR status=$1) ORDER BY id DESC LIMIT $2 OFFSET $3',[status,limit,offset])).rows;
  const counts=Object.fromEntries((await pool.query("SELECT status,count(*)::int n FROM email_outbox GROUP BY status")).rows.map((r:any)=>[r.status,r.n]));
  return {items:rows,counts};
 });
 app.post('/api/email/outbox/:id/retry',async(req)=>{
  admin(req);
  const r=await pool.query("UPDATE email_outbox SET status='queued',next_attempt_at=now(),attempts=0 WHERE id=$1 AND status IN ('failed','queued') RETURNING id",[Number((req.params as any).id)||0]);
  if(!r.rowCount)fail(404,'That message cannot be retried');
  return {ok:true};
 });
}
