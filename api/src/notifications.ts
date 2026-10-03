import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,txt,asId,audit,encrypt,decrypt,looksLikeEmail} from './core.js';
import {safeRequest,GuardError} from './netguard.js';
import {sendMail,mailerReady} from './mailer.js';
import {settings} from './settings.js';
import {brand} from './branding.js';

// The notification center. Things worth knowing about (a server crashed, a backup failed, a node
// went offline ...) become an inbox entry for the people concerned and are delivered to the
// channels they set up: webhooks (Discord, Slack, Mattermost or anything that takes JSON) and email.

export type Severity='info'|'warn'|'bad'|'ok';
export type EventDef={id:string;label:string;scope:'server'|'panel';severity:Severity};
export const EVENTS:EventDef[]=[
 {id:'server.crashed',label:'A server crashed',scope:'server',severity:'bad'},
 {id:'server.crashloop',label:'A server keeps crashing (automatic restarts stopped)',scope:'server',severity:'bad'},
 {id:'server.recovered',label:'A crashed server is running again',scope:'server',severity:'ok'},
 {id:'server.disk_high',label:'A server’s disk is almost full',scope:'server',severity:'warn'},
 {id:'backup.failed',label:'A backup failed',scope:'server',severity:'bad'},
 {id:'backup.verification_failed',label:'A backup failed its verification',scope:'server',severity:'bad'},
 {id:'schedule.failed',label:'A scheduled task failed',scope:'server',severity:'warn'},
 {id:'addon.failed',label:'A mod or plugin install or update failed',scope:'server',severity:'warn'},
 {id:'failover.started',label:'A server is being recovered on another node',scope:'server',severity:'warn'},
 {id:'failover.blocked',label:'A server cannot be recovered automatically',scope:'server',severity:'bad'},
 {id:'node.offline',label:'A node went offline',scope:'panel',severity:'bad'},
 {id:'node.online',label:'A node is back online',scope:'panel',severity:'ok'},
 {id:'agent.update_failed',label:'A node agent update failed',scope:'panel',severity:'warn'},
 {id:'update.available',label:'A new Fledge version is available',scope:'panel',severity:'info'},
 {id:'plugin.disabled',label:'A plugin was turned off after repeated failures',scope:'panel',severity:'warn'},
 {id:'signup.pending',label:'A new customer is waiting for approval',scope:'panel',severity:'info'},
 {id:'billing.fulfilment_failed',label:'A paid server could not be created',scope:'panel',severity:'bad'},
 {id:'billing.payment_failed',label:'A customer’s payment failed',scope:'panel',severity:'warn'},
 {id:'billing.dispute',label:'A customer opened a payment dispute',scope:'panel',severity:'bad'},
 {id:'billing.health',label:'Billing needs attention (webhooks, drift)',scope:'panel',severity:'warn'},
 {id:'limit.exceeded',label:'A customer went over a limit',scope:'panel',severity:'warn'},
];
const eventDef=(id:string)=>EVENTS.find(e=>e.id===id);

export type Emit={kind:string;title:string;body?:string;severity?:Severity;serverId?:string|null;nodeId?:string|null;data?:Record<string,unknown>;dedupe?:{key:string;minutes:number}};

export function payloadFor(channelKind:string,ev:{kind:string;severity:Severity;title:string;body:string;server?:{id:string;name:string}|null;nodeId?:string|null;data?:Record<string,unknown>;at?:string},brandName='Fledge'){
 const text=`${brandName}: ${ev.title}${ev.server?` (${ev.server.name})`:''}${ev.body?` — ${ev.body}`:''}`.slice(0,1900);
 if(channelKind==='discord')return {content:text};
 if(channelKind==='slack')return {text};
 // `text` and `content` make the generic payload work with Slack, Discord and Mattermost; `event` carries the data.
 return {text,content:text,event:{kind:ev.kind,severity:ev.severity,title:ev.title,body:ev.body,server:ev.server||null,nodeId:ev.nodeId||null,data:ev.data||{},at:ev.at||new Date().toISOString()}};
}

async function deliver(ch:any,ev:{kind:string;severity:Severity;title:string;body:string;server?:{id:string;name:string}|null;nodeId?:string|null;data?:Record<string,unknown>}){
 let status='sent',error:string|null=null;
 try{
  if(ch.kind==='email'){
   if(!(await mailerReady()))throw new Error('Email is not set up');
   const b=await brand();
   const text=`${ev.title}\n\n${ev.body||''}${ev.server?`\n\nServer: ${ev.server.name}`:''}\n\n— ${b.name}`;
   await sendMail({to:String(ch.config?.to||''),subject:`[${b.short}] ${ev.title}`,text});
  }else{
   const url=JSON.parse(decrypt(ch.secret)).url as string;
   const res=await safeRequest(url,{method:'POST',body:JSON.stringify(payloadFor(ch.kind,ev,(await brand()).name)),headers:{'content-type':'application/json'},maxBytes:64*1024,timeoutMs:8000,redirects:0,
    ...(ch.scope==='user'?{}:{allowPrivate:true,allowHttp:true}),...(process.env.FLEDGE_TEST_ALLOW_LOCAL_FETCH==='1'?{allowPrivate:true,allowHttp:true}:{})});
   if(res.status<200||res.status>=300)throw new Error(`The endpoint answered ${res.status}`);
  }
 }catch(e:any){status='failed';error=(e instanceof GuardError?e.message:String(e?.message||'error')).slice(0,300);}
 await pool.query('UPDATE notification_channels SET last_status=$2,last_error=$3,last_sent_at=now() WHERE id=$1',[ch.id,status,error]).catch(()=>{});
 return {status,error};
}

export async function emit(ev:Emit){
 try{
  if(ev.dedupe){
   const hit=await pool.query("SELECT 1 FROM notifications WHERE kind=$1 AND data->>'dedupe'=$2 AND created_at>now()-make_interval(mins=>$3::int) LIMIT 1",[ev.kind,ev.dedupe.key,ev.dedupe.minutes]);
   if(hit.rowCount)return;
  }
  const def=eventDef(ev.kind),severity=ev.severity||def?.severity||'info',body=(ev.body||'').slice(0,1000),title=ev.title.slice(0,200);
  let server:{id:string;name:string}|null=null,recipients:string[]=[];
  if(ev.serverId){
   const s=(await pool.query('SELECT id,name,owner_id FROM servers WHERE id=$1',[ev.serverId])).rows[0];
   if(s){
    server={id:s.id,name:s.name};
    const collab=(await pool.query("SELECT user_id FROM collaborators WHERE server_id=$1 AND permissions && ARRAY['view','console','files','backups','manage']::text[]",[s.id])).rows.map((r:any)=>r.user_id);
    recipients=[...new Set([s.owner_id,...collab])];
   }
  }
  const data={...(ev.data||{}),...(ev.dedupe?{dedupe:ev.dedupe.key}:{})};
  const ins=(user:string|null)=>pool.query('INSERT INTO notifications(user_id,kind,severity,title,body,server_id,node_id,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[user,ev.kind,severity,title,body,server?.id||null,ev.nodeId||null,JSON.stringify(data)]);
  await ins(null); // administrators
  if(def?.scope!=='panel')for(const u of recipients)await ins(u);
  const channels=(await pool.query("SELECT * FROM notification_channels WHERE enabled AND $1=ANY(events) AND (scope='panel' OR user_id=ANY($2::uuid[])) AND (server_ids IS NULL OR $3::uuid=ANY(server_ids) OR $3::uuid IS NULL)",[ev.kind,recipients,server?.id||null])).rows;
  const payload={kind:ev.kind,severity,title,body,server,nodeId:ev.nodeId||null,data};
  void Promise.allSettled(channels.map(ch=>deliver(ch,payload)));
 }catch(e){console.error('Could not record a notification:',(e as Error)?.message);}
}

/** An in-panel notification for one person (or null for the administrators), with optional de-duplication. */
export async function notifyUser(userId:string|null,ev:{kind:string;title:string;body?:string;severity?:Severity;data?:Record<string,unknown>;dedupe?:{key:string;minutes:number}}){
 try{
  if(ev.dedupe){
   const hit=await pool.query("SELECT 1 FROM notifications WHERE kind=$1 AND data->>'dedupe'=$2 AND created_at>now()-make_interval(mins=>$3::int) LIMIT 1",[ev.kind,ev.dedupe.key,ev.dedupe.minutes]);
   if(hit.rowCount)return;
  }
  const data={...(ev.data||{}),...(ev.dedupe?{dedupe:ev.dedupe.key}:{})};
  await pool.query('INSERT INTO notifications(user_id,kind,severity,title,body,data) VALUES($1,$2,$3,$4,$5,$6)',[userId,ev.kind,ev.severity||'info',ev.title.slice(0,200),(ev.body||'').slice(0,1000),JSON.stringify(data)]);
 }catch(e){console.error('Could not record a notification:',(e as Error)?.message);}
}

const secretOf=(url:string)=>encrypt(JSON.stringify({url}));
const hostOf=(ch:any)=>{try{return new URL(JSON.parse(decrypt(ch.secret)).url).host;}catch{return null;}};
const channelShape=(ch:any)=>({id:ch.id,scope:ch.scope,name:ch.name,kind:ch.kind,events:ch.events,serverIds:ch.server_ids,enabled:ch.enabled,
 to:ch.kind==='email'?ch.config?.to||null:null,urlHost:ch.kind==='email'?null:hostOf(ch),lastStatus:ch.last_status,lastError:ch.last_error,lastSentAt:ch.last_sent_at,createdAt:ch.created_at,mine:undefined as any});

async function accessibleServers(userId:string){
 return new Set<string>((await pool.query("SELECT s.id FROM servers s WHERE s.deleted_at IS NULL AND (s.owner_id=$1 OR EXISTS(SELECT 1 FROM collaborators c WHERE c.server_id=s.id AND c.user_id=$1 AND c.permissions && ARRAY['view','console','files','backups','manage']::text[]))",[userId])).rows.map((r:any)=>r.id));
}

export function notificationRoutes(app:FastifyInstance){
 const visible=(req:any)=>req.actor.role==='admin'?'(user_id IS NULL OR user_id=$1)':'user_id=$1';
 app.get('/api/notification-events',async(req)=>EVENTS.filter(e=>req.actor?.role==='admin'||e.scope==='server'));
 app.get('/api/notifications',async(req)=>{
  const q=req.query as any,limit=Math.min(100,Math.max(1,Number(q?.limit)||30)),before=Number(q?.before)||0;
  const seen=(await pool.query('SELECT notifications_seen_id FROM users WHERE id=$1',[req.actor!.id])).rows[0]?.notifications_seen_id||0;
  const rows=(await pool.query(`SELECT n.id,n.kind,n.severity,n.title,n.body,n.server_id AS "serverId",n.node_id AS "nodeId",n.created_at AS "createdAt",s.name AS "serverName" FROM notifications n LEFT JOIN servers s ON s.id=n.server_id WHERE ${visible(req).replace(/user_id/g,'n.user_id')} AND ($2::bigint=0 OR n.id<$2) ${q?.unread==='1'?'AND n.id>$4':''} ORDER BY n.id DESC LIMIT $3`,q?.unread==='1'?[req.actor!.id,before,limit,seen]:[req.actor!.id,before,limit])).rows;
  const unread=(await pool.query(`SELECT count(*)::int n FROM notifications WHERE ${visible(req)} AND id>$2`,[req.actor!.id,seen])).rows[0].n;
  return {items:rows.map((r:any)=>({...r,id:Number(r.id),unread:Number(r.id)>Number(seen)})),unread,seenId:Number(seen)};
 });
 app.get('/api/notifications/summary',async(req)=>{
  const seen=(await pool.query('SELECT notifications_seen_id FROM users WHERE id=$1',[req.actor!.id])).rows[0]?.notifications_seen_id||0;
  return {unread:(await pool.query(`SELECT count(*)::int n FROM notifications WHERE ${visible(req)} AND id>$2`,[req.actor!.id,seen])).rows[0].n};
 });
 app.post('/api/notifications/read',async(req)=>{
  const upTo=Number((req.body as any)?.upTo)||0;
  const max=(await pool.query(`SELECT coalesce(max(id),0) AS m FROM notifications WHERE ${visible(req)} ${upTo?'AND id<=$2':''}`,upTo?[req.actor!.id,upTo]:[req.actor!.id])).rows[0].m;
  await pool.query('UPDATE users SET notifications_seen_id=GREATEST(notifications_seen_id,$2) WHERE id=$1',[req.actor!.id,max]);
  return {ok:true,seenId:Number(max)};
 });

 app.get('/api/notification-channels',async(req)=>{
  const rows=(await pool.query(req.actor!.role==='admin'?"SELECT * FROM notification_channels WHERE scope='panel' OR user_id=$1 ORDER BY created_at":"SELECT * FROM notification_channels WHERE user_id=$1 ORDER BY created_at",[req.actor!.id])).rows;
  return rows.map(ch=>({...channelShape(ch),mine:ch.user_id===req.actor!.id}));
 });
 const parse=async(req:any,existing?:any)=>{
  const b=req.body as any,isAdmin=req.actor.role==='admin';
  const scope=existing?existing.scope:(isAdmin&&b?.scope!=='user'?'panel':'user');
  const kind=existing?existing.kind:String(b?.kind||'');
  if(!['webhook','discord','slack','email'].includes(kind))fail(400,'kind must be webhook, discord, slack or email');
  const allowedEvents=EVENTS.filter(e=>scope==='panel'||e.scope==='server'||isAdmin).map(e=>e.id);
  const events=b?.events!==undefined?b.events:existing?.events;
  if(!Array.isArray(events)||!events.length||events.some((e:any)=>!allowedEvents.includes(e)))fail(400,'Choose at least one event from the list');
  let serverIds:string[]|null=b?.serverIds!==undefined?b.serverIds:(existing?.server_ids??null);
  if(serverIds!==null){
   if(!Array.isArray(serverIds)||serverIds.length>200)fail(400,'serverIds must be a list');
   serverIds=serverIds.map(asId);
   if(!serverIds.length)serverIds=null;
   else if(!isAdmin){const mine=await accessibleServers(req.actor.id);if(serverIds.some(id=>!mine.has(id)))fail(404,'Server not found');}
  }
  const name=b?.name!==undefined?txt(b.name,60):existing?.name;
  let config:any=existing?.config||{},secret:string|null=existing?.secret||null;
  if(kind==='email'){
   const to=b?.to!==undefined?txt(b.to,254).toLowerCase():config.to;
   if(!looksLikeEmail(to))fail(400,'Enter a valid email address');
   if(!isAdmin&&to!==req.actor.email.toLowerCase())fail(403,'You can only send notifications to your own email address');
   if(!(await mailerReady()))fail(409,'Email is not set up. An administrator can turn it on in Settings → Email.');
   config={to};secret=null;
  }else if(b?.url!==undefined||!existing){
   const raw=txt(b?.url,1000);let u:URL;
   try{u=new URL(raw);}catch{return fail(400,'Enter a valid webhook URL');}
   if(u.username||u.password)fail(400,'The URL must not contain a user name or password');
   if(scope==='user'&&u.protocol!=='https:')fail(400,'Webhook URLs must use HTTPS');
   if(!['http:','https:'].includes(u.protocol))fail(400,'Webhook URLs must start with https://');
   secret=secretOf(raw);config={};
  }
  return {scope,kind,name,events,serverIds,config,secret,enabled:typeof b?.enabled==='boolean'?b.enabled:(existing?.enabled??true)};
 };
 app.post('/api/notification-channels',async(req)=>{
  const mine=(await pool.query("SELECT count(*)::int n FROM notification_channels WHERE user_id=$1",[req.actor!.id])).rows[0].n;
  if(mine>=10)fail(409,'You can have at most 10 notification channels');
  const p=await parse(req);
  const row=(await pool.query('INSERT INTO notification_channels(scope,user_id,name,kind,config,secret,events,server_ids,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[p.scope,p.scope==='user'?req.actor!.id:null,p.name,p.kind,JSON.stringify(p.config),p.secret,p.events,p.serverIds,p.enabled])).rows[0];
  await audit(req.actor!.id,'notification.channel.create','notification_channel',row.id,{kind:p.kind,scope:p.scope});
  return {...channelShape(row),mine:row.user_id===req.actor!.id};
 });
 const own=async(req:any)=>{
  const ch=(await pool.query('SELECT * FROM notification_channels WHERE id=$1',[asId((req.params as any).id)])).rows[0];
  if(!ch||(ch.scope==='panel'?req.actor.role!=='admin':ch.user_id!==req.actor.id))fail(404,'Channel not found');
  return ch;
 };
 app.patch('/api/notification-channels/:id',async(req)=>{
  const ch=await own(req),p=await parse(req,ch);
  const row=(await pool.query('UPDATE notification_channels SET name=$2,config=$3,secret=$4,events=$5,server_ids=$6,enabled=$7 WHERE id=$1 RETURNING *',[ch.id,p.name,JSON.stringify(p.config),p.secret,p.events,p.serverIds,p.enabled])).rows[0];
  await audit(req.actor!.id,'notification.channel.update','notification_channel',ch.id);
  return {...channelShape(row),mine:row.user_id===req.actor!.id};
 });
 app.delete('/api/notification-channels/:id',async(req)=>{
  const ch=await own(req);
  await pool.query('DELETE FROM notification_channels WHERE id=$1',[ch.id]);
  await audit(req.actor!.id,'notification.channel.delete','notification_channel',ch.id);
  return {ok:true};
 });
 app.post('/api/notification-channels/:id/test',async(req)=>{
  const ch=await own(req);
  const r=await deliver(ch,{kind:'test',severity:'info',title:'Test notification',body:'If you can read this, the channel works.',server:null,data:{test:true}});
  if(r.status!=='sent')fail(502,`The test message could not be delivered: ${r.error}`);
  return {ok:true};
 });
}

/** Housekeeping: keep the inbox bounded. */
export async function sweepNotifications(){
 await pool.query("DELETE FROM notifications WHERE created_at<now()-interval '30 days'");
}
void admin;void settings;
