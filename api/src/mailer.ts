import nodemailer from 'nodemailer';
import {settings} from './settings.js';
import {fail} from './core.js';
import {brand,senderWithName} from './branding.js';

// Outgoing email (invitations, password resets, notification channels). Configured in
// Settings → Email; the SMTP password is stored encrypted like the other secrets.

export async function mailerReady(){const e=(await settings()).email;return e.enabled&&!!e.host&&!!e.from;}

export async function sendMail(msg:{to:string;subject:string;text:string;html?:string}){
 const cfg=(await settings()).email;
 if(!cfg.enabled||!cfg.host||!cfg.from)fail(503,'Email is not set up. An administrator can turn it on in Settings → Email.');
 const transport=nodemailer.createTransport({host:cfg.host,port:cfg.port,secure:cfg.security==='tls',requireTLS:cfg.security==='starttls',ignoreTLS:cfg.security==='none',
  auth:cfg.user?{user:cfg.user,pass:cfg.password}:undefined,connectionTimeout:10_000,greetingTimeout:10_000,socketTimeout:20_000});
 try{
  // Appearance settings add a sender name (when the configured address has none) and a footer to every email.
  const b=await brand();
  await transport.sendMail({from:senderWithName(cfg.from,b.emailFromName),to:msg.to,subject:msg.subject.replace(/[\r\n]+/g,' ').slice(0,200),text:b.footer?`${msg.text.replace(/\s+$/,'')}\n\n${b.footer}\n`:msg.text,...(msg.html?{html:msg.html}:{})});
 }catch(e:any){
  throw Object.assign(new Error(`The mail server refused or could not be reached: ${String(e?.response||e?.message||'error').slice(0,200)}`),{statusCode:502,error:'mail_failed'});
 }finally{transport.close();}
}

/** Escapes text for the small HTML bodies we send. */
export const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] as string));
