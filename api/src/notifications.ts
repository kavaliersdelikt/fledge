import type {FastifyInstance} from 'fastify';
import {pool,admin,fail,txt,asId,audit,encrypt,decrypt,looksLikeEmail,WEB_ORIGIN} from './core.js';
import {renderDiscord,discordStyles} from './notification-styles.js';
import {safeRequest,GuardError} from './netguard.js';
import {sendMail,mailerReady} from './mailer.js';
import {settings} from './settings.js';
import {brand} from './branding.js';

// The notification center. Things worth knowing about (a server crashed, a backup failed, a node
// went offline ...) become an inbox entry for the people concerned and are delivered to the
// channels they set up: webhooks (Discord, Slack, Mattermost or anything that takes JSON) and email.

export type Severity='info'|'warn'|'bad'|'ok';
export type EventDef={id:string;label:string;scope:'server'|'panel'|'account';severity:Severity};
export const EVENTS:EventDef[]=[
 {id:'suspension.created',label:'Account suspended',scope:'account',severity:'warn'},
 {id:'suspension.updated',label:'Account suspension updated',scope:'account',severity:'info'},
 {id:'suspension.lifted',label:'Account suspension lifted',scope:'account',severity:'ok'},
 {id:'suspension.appeal_created',label:'New suspension appeal',scope:'panel',severity:'warn'},
 {id:'suspension.appeal_replied',label:'Suspension appeal replied to',scope:'account',severity:'info'},
 {id:'suspension.retention_scheduled',label:'Suspension termination scheduled',scope:'panel',severity:'warn'},
 {id:'suspension.retention_cancelled',label:'Suspension termination cancelled',scope:'panel',severity:'ok'},
 {id:'support.assigned',label:'Ticket assignment changed',scope:'panel',severity:'info'},
 {id:'support.agent_replied',label:'Support team replied',scope:'account',severity:'info'},
 {id:'support.status_changed',label:'Ticket status changed',scope:'account',severity:'info'},
 {id:'support.reopened',label:'Ticket reopened',scope:'account',severity:'info'},
 {id:'support.rated',label:'Ticket rated',scope:'panel',severity:'info'},
 {id:'support.abuse_reported',label:'New abuse report',scope:'panel',severity:'warn'},
 {id:'vm.provisioned',label:'Virtual machine provisioned',scope:'server',severity:'ok'},
 {id:'vm.provision_failed',label:'Virtual machine provisioning failed',scope:'server',severity:'bad'},
 {id:'vm.power_failed',label:'Virtual machine power operation failed',scope:'server',severity:'bad'},
 {id:'vm.installation_changed',label:'Virtual machine installation changed',scope:'server',severity:'info'},
 {id:'vm.snapshot_created',label:'Virtual machine snapshot created',scope:'server',severity:'ok'},
 {id:'vm.snapshot_restored',label:'Virtual machine snapshot restored',scope:'server',severity:'warn'},
 {id:'vm.snapshot_deleted',label:'Virtual machine snapshot deleted',scope:'server',severity:'info'},
 {id:'vm.operation_failed',label:'Virtual machine operation failed',scope:'server',severity:'bad'},
 {id:'vm.restored',label:'Virtual machine backup restored',scope:'server',severity:'ok'},
 {id:'vm.migrated',label:'Virtual machine migration completed',scope:'server',severity:'ok'},
 {id:'vm.migration_failed',label:'Virtual machine migration or recovery failed',scope:'server',severity:'bad'},
 {id:'vm.resource_warning',label:'Virtual machine resources need attention',scope:'server',severity:'warn'},

 {id:'support.ticket_created',label:'New support ticket',scope:'panel',severity:'info'},
 {id:'support.customer_replied',label:'Customer replied to a ticket',scope:'panel',severity:'info'},
 {id:'support.deadline_warning',label:'Support deadline approaching',scope:'panel',severity:'warn'},
 {id:'support.deadline_breached',label:'Support deadline breached',scope:'panel',severity:'bad'},
 {id:'support.rating_low',label:'Low support rating',scope:'panel',severity:'warn'},
 {id:'suspension.retention',label:'Suspension retention reached',scope:'panel',severity:'warn'},

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

export type Emit={kind:string;title:string;body?:string;severity?:Severity;serverId?:string|null;nodeId?:string|null;recipientIds?:string[];data?:Record<string,unknown>;dedupe?:{key:string;minutes:number}};

export function payloadFor(channelKind:string,ev:{kind:string;severity:Severity;title:string;body:string;server?:{id:string;name:string}|null;nodeId?:string|null;data?:Record<string,unknown>;at?:string},brandName='Fledge'){
 const text=`${brandName}: ${ev.title}${ev.server?` (${ev.server.name})`:''}${ev.body?` — ${ev.body}`:''}`.slice(0,1900);
 // Never let a server or customer name ping @everyone, a role or a person on the receiving side.
 if(channelKind==='discord')return {content:text,allowed_mentions:{parse:[]}};
 if(channelKind==='slack')return {text};
 // `text` and `content` make the generic payload work with Slack, Discord and Mattermost; `event` carries the data.
 return {text,content:text,allowed_mentions:{parse:[]},event:{kind:ev.kind,severity:ev.severity,title:ev.title,body:ev.body,server:ev.server||null,nodeId:ev.nodeId||null,data:ev.data||{},at:ev.at||new Date().toISOString()}};
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
   const b=await brand();
   let body:Record<string,unknown>=payloadFor(ch.kind,ev,b.name);
   // A channel set to a rich style asks the formatter plugin to lay the message out; anything going wrong means the plain message.
   if(ch.kind==='discord'&&ch.config?.style&&ch.config.style!=='plain'){
    const rich=await renderDiscord({style:ch.config.style,scope:ch.scope==='user'?'user':'panel',brand:b.name,panelUrl:WEB_ORIGIN.replace(/\/$/,''),event:{...ev,at:new Date().toISOString(),body:ev.body||''}}).catch(()=>null);
    if(rich)body=rich;
   }
   const res=await safeRequest(url,{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',...(ch.delivery_id?{'idempotency-key':ch.delivery_id}:{})},maxBytes:64*1024,timeoutMs:8000,redirects:0,
    ...(ch.scope==='user'?{}:{allowPrivate:true,allowHttp:true}),...(process.env.FLEDGE_TEST_ALLOW_LOCAL_FETCH==='1'?{allowPrivate:true,allowHttp:true}:{})});
   if(res.status<200||res.status>=300)throw new Error(`The endpoint answered ${res.status}`);
  }
 }catch(e:any){status='failed';error=(e instanceof GuardError?e.message:String(e?.message||'error')).slice(0,300);}
 await pool.query('UPDATE notification_channels SET last_status=$2,last_error=$3,last_sent_at=now() WHERE id=$1',[ch.id,status,error]).catch(()=>{});
 return {status,error};
}

function requiredGrant(kind:string){
 if(kind.startsWith('support.'))return 'support.view';
 if(kind.startsWith('suspension.'))return 'customers.suspend';
 if(kind.startsWith('vm.')||/^(server|backup|schedule|addon|failover)\./.test(kind))return 'servers.view';
 if(kind.startsWith('billing.'))return 'billing.view';
 if(kind.startsWith('node.')||kind.startsWith('agent.'))return 'nodes.view';
 if(kind.startsWith('signup.')||kind.startsWith('limit.'))return 'customers.view';
 if(kind.startsWith('plugin.'))return 'plugins.view';
 return 'settings.view';
}
async function channelAllowed(ch:any,kind:string){
 const u=(await pool.query('SELECT * FROM users WHERE id=$1 AND NOT disabled AND status=\'active\'',[ch.user_id])).rows[0];
 if(!u)return false;
 if(ch.scope==='panel')return u.role==='admin'&&!!u.totp_secret&&(u.is_super||u.admin_permissions===null||u.admin_permissions.includes(requiredGrant(kind)));
 return !(await pool.query('SELECT 1 FROM account_suspensions WHERE user_id=$1 AND lifted_at IS NULL',[u.id])).rowCount || kind.startsWith('suspension.') || kind.startsWith('support.');
}
export async function emit(ev:Emit){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  if(ev.dedupe){
   const claimed=await c.query("INSERT INTO notification_emissions(identity,expires_at) VALUES($1,now()+make_interval(mins=>$2::int)) ON CONFLICT(identity) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE notification_emissions.expires_at<=now() RETURNING identity",[ev.kind+':'+ev.dedupe.key,ev.dedupe.minutes]);
   if(!claimed.rowCount){await c.query('ROLLBACK');return;}
  }
  const def=eventDef(ev.kind),severity=ev.severity||def?.severity||'info',body=(ev.body||'').slice(0,1000),title=ev.title.slice(0,200);
  let server:{id:string;name:string}|null=null,recipients:string[]=[];
  if(ev.serverId){
   const workload=(await c.query('SELECT id,name,owner_id FROM servers WHERE id=$1',[ev.serverId])).rows[0];
   if(workload){server={id:workload.id,name:workload.name};const collab=(await c.query("SELECT user_id FROM collaborators WHERE server_id=$1 AND permissions && ARRAY['view','console','files','backups','manage','vm.configure','vm.network','vm.media','vm.snapshots']::text[]",[workload.id])).rows.map((r:any)=>r.user_id);recipients=[...new Set([workload.owner_id,...collab])];}
  }
  if(ev.recipientIds)recipients=[...new Set(ev.recipientIds)];
  const data={...(ev.data||{}),...(ev.dedupe?{dedupe:ev.dedupe.key}:{})};
  const ins=(user:string|null)=>c.query('INSERT INTO notifications(user_id,kind,severity,title,body,server_id,node_id,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[user,ev.kind,severity,title,body,server?.id||null,ev.nodeId||null,JSON.stringify(data)]);
  await ins(null);
  if(def?.scope!=='panel')for(const u of recipients)await ins(u);
  const channels=(await c.query("SELECT * FROM notification_channels WHERE enabled AND $1=ANY(events) AND (scope='panel' OR user_id=ANY($2::uuid[])) AND (server_ids IS NULL OR $3::uuid=ANY(server_ids))",[ev.kind,recipients,server?.id||null])).rows;
  const payload={kind:ev.kind,severity,title,body,server,nodeId:ev.nodeId||null,data};
  for(const ch of channels)await c.query('INSERT INTO notification_deliveries(channel_id,payload) VALUES($1,$2)',[ch.id,JSON.stringify(payload)]);
  await c.query('COMMIT');
  void dispatchNotifications();
 }catch(e){await c.query('ROLLBACK');console.error('Could not record a notification:',(e as Error)?.message);}finally{c.release()}
}
let dispatching=false;
export async function dispatchNotifications(){
 if(dispatching)return;dispatching=true;
 const c=await pool.connect().catch(e=>{dispatching=false;throw e});
 try {
  await c.query('BEGIN');
  const deliveries=(await c.query("SELECT d.id AS delivery_id,d.payload,d.attempts,ch.* FROM notification_deliveries d JOIN notification_channels ch ON ch.id=d.channel_id WHERE d.state='pending' AND d.available_at<=now() ORDER BY d.created_at LIMIT 4 FOR UPDATE OF d SKIP LOCKED")).rows;
  for(const row of deliveries){
   if(!row.enabled||!row.events.includes(row.payload.kind)||!await channelAllowed(row,row.payload.kind)){await c.query("UPDATE notification_deliveries SET state='failed' WHERE id=$1",[row.delivery_id]);continue;}
   const result=await deliver(row,row.payload),attempts=row.attempts+1;
   await c.query("UPDATE notification_deliveries SET attempts=$2,state=$3,available_at=now()+make_interval(secs=>$4) WHERE id=$1",[row.delivery_id,attempts,result.status==='sent'?'sent':attempts>=5?'failed':'pending',Math.min(3600,30*2**attempts)]);
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');console.error('Notification delivery failed:',(e as Error).message)}finally{c.release();dispatching=false}
}

/** An in-panel notification for one person (or null for the administrators), with optional de-duplication. */
export async function notifyUser(userId:string|null,ev:{kind:string;title:string;body?:string;severity?:Severity;data?:Record<string,unknown>;dedupe?:{key:string;minutes:number}}){
 try{

  const data={...(ev.data||{}),...(ev.dedupe?{dedupe:ev.dedupe.key}:{})};
  const args=[userId,ev.kind,ev.severity||'info',ev.title.slice(0,200),(ev.body||'').slice(0,1000),JSON.stringify(data)];
  if(ev.dedupe)await pool.query(`WITH claim AS (INSERT INTO notification_emissions(identity,expires_at) VALUES($7,now()+make_interval(mins=>$8::int)) ON CONFLICT(identity) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE notification_emissions.expires_at<=now() RETURNING identity) INSERT INTO notifications(user_id,kind,severity,title,body,data) SELECT $1::uuid,$2,$3,$4,$5,$6::jsonb FROM claim`,[...args,'inbox:'+String(userId)+':'+ev.kind+':'+ev.dedupe.key,ev.dedupe.minutes]);
  else await pool.query('INSERT INTO notifications(user_id,kind,severity,title,body,data) VALUES($1,$2,$3,$4,$5,$6)',args);
 }catch(e){console.error('Could not record a notification:',(e as Error)?.message);}
}

const secretOf=(url:string)=>encrypt(JSON.stringify({url}));
const hostOf=(ch:any)=>{try{return new URL(JSON.parse(decrypt(ch.secret)).url).host;}catch{return null;}};
const channelShape=(ch:any)=>({style:ch.kind==='discord'?(ch.config?.style||'plain'):null,id:ch.id,scope:ch.scope,name:ch.name,kind:ch.kind,events:ch.events,serverIds:ch.server_ids,enabled:ch.enabled,
 to:ch.kind==='email'?ch.config?.to||null:null,urlHost:ch.kind==='email'?null:hostOf(ch),lastStatus:ch.last_status,lastError:ch.last_error,lastSentAt:ch.last_sent_at,createdAt:ch.created_at,mine:undefined as any});

async function accessibleServers(userId:string){
 return new Set<string>((await pool.query("SELECT s.id FROM servers s WHERE s.deleted_at IS NULL AND (s.owner_id=$1 OR EXISTS(SELECT 1 FROM collaborators c WHERE c.server_id=s.id AND c.user_id=$1 AND c.permissions && ARRAY['view','console','files','backups','manage','vm.configure','vm.network','vm.media','vm.snapshots']::text[]))",[userId])).rows.map((r:any)=>r.id));
}

export function notificationRoutes(app:FastifyInstance){
 const visible=(req:any)=>{
  if(req.actor.role!=='admin')return 'user_id=$1';
  const has=(p:string)=>req.actor.isSuper||req.actor.permissions?.includes(p);
  const filters=[['support.','support.view'],['suspension.','customers.view'],['server.','servers.view'],['billing.','billing.view'],['node.','nodes.view'],['vm.','servers.view'],['backup.','servers.view'],['schedule.','servers.view'],['addon.','servers.view'],['failover.','servers.view'],['signup.','customers.view'],['limit.','customers.view']].filter(([,p])=>!has(p)).map(([prefix])=>`kind NOT LIKE '${prefix}%'`);
  return `(user_id=$1 OR (user_id IS NULL${filters.length?' AND '+filters.join(' AND '):''}))`;
 };
 app.get('/api/notification-events',async(req)=>EVENTS.filter(e=>req.actor?.role==='admin'||e.scope!=='panel'));
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

 // The message styles a Discord channel can use right now: plain text, plus whatever an enabled formatter plugin offers.
 app.get('/api/notification-styles',async()=>({discord:await discordStyles()}));
 app.get('/api/notification-channels',async(req)=>{
  const rows=(await pool.query(req.actor!.role==='admin'?"SELECT * FROM notification_channels WHERE scope='panel' OR user_id=$1 ORDER BY created_at":"SELECT * FROM notification_channels WHERE user_id=$1 ORDER BY created_at",[req.actor!.id])).rows;
  return rows.map(ch=>({...channelShape(ch),mine:ch.user_id===req.actor!.id}));
 });
 const parse=async(req:any,existing?:any)=>{
  const b=req.body as any,isAdmin=req.actor.role==='admin';
  const scope=existing?existing.scope:(isAdmin&&b?.scope!=='user'?'panel':'user');
  const kind=existing?existing.kind:String(b?.kind||'');
  if(!['webhook','discord','slack','email'].includes(kind))fail(400,'kind must be webhook, discord, slack or email');
  const allowedEvents=EVENTS.filter(e=>scope==='panel'||e.scope!=='panel'||isAdmin).map(e=>e.id);
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
  let style:string=existing?.config?.style||'plain';
  if(kind==='discord'&&b?.style!==undefined){
   const known=(await discordStyles()).map(s=>s.id);
   if(typeof b.style!=='string'||!/^[a-z][a-z0-9-]{0,30}$/.test(b.style))fail(400,'Choose a message style from the list');
   if(!known.includes(b.style))fail(409,'That message style is not available. Turn on the plugin that provides it (Plugins).');
   style=b.style;
  }
  if(kind!=='discord'&&b?.style!==undefined&&b.style!=='plain')fail(400,'Message styles are only for Discord channels');
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
  if(kind==='discord')config={...config,style};
  return {scope,kind,name,events,serverIds,config,secret,enabled:typeof b?.enabled==='boolean'?b.enabled:(existing?.enabled??true)};
 };
 app.post('/api/notification-channels',async(req)=>{
  const mine=(await pool.query("SELECT count(*)::int n FROM notification_channels WHERE user_id=$1",[req.actor!.id])).rows[0].n;
  if(mine>=10)fail(409,'You can have at most 10 notification channels');
  const p=await parse(req);
  const row=(await pool.query('INSERT INTO notification_channels(scope,user_id,name,kind,config,secret,events,server_ids,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[p.scope,req.actor!.id,p.name,p.kind,JSON.stringify(p.config),p.secret,p.events,p.serverIds,p.enabled])).rows[0];
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
 await dispatchNotifications();await pool.query("DELETE FROM notifications WHERE created_at<now()-interval '30 days'");await pool.query("DELETE FROM notification_deliveries WHERE state<>'pending' AND created_at<now()-interval '30 days'");await pool.query('DELETE FROM notification_emissions WHERE expires_at<now()');
}
void admin;void settings;
