import type {FastifyInstance} from 'fastify';
import {admin} from './core.js';
import {panelVersion} from './plugins/manager.js';

// A generated OpenAPI 3.1 description of the API. Routes are collected as they are registered, so
// nothing can be missing; the table below adds summaries, access levels and request fields for the
// endpoints people integrate with. Anything not in the table is still listed (as "Undocumented").

type Access='public'|'session'|'admin'|'agent'|'token';
type Doc={tag:string;summary:string;access:Access;body?:string;scope?:string};
const routes:{method:string;url:string}[]=[];

// Mirrors the endpoint allow-list for API tokens in authenticate() (core.ts); bearer tokens reach nothing else.
const TOKEN_READ=new Set(['/api/auth/me','/api/customers','/api/customers/:id','/api/servers','/api/servers/:id','/api/jobs','/api/templates']);
const TOKEN_PROVISION=new Set(['/api/customers','/api/servers']);
export const tokenScopeFor=(method:string,url:string)=>method==='GET'&&TOKEN_READ.has(url)?'read':method==='POST'&&TOKEN_PROVISION.has(url)?'provision':method==='POST'&&url==='/api/servers/:id/actions'?'suspend':null;

export function captureRoutes(app:FastifyInstance){
 app.addHook('onRoute',r=>{
  for(const m of Array.isArray(r.method)?r.method:[r.method])if(m!=='HEAD'&&m!=='OPTIONS'&&typeof r.url==='string'&&r.url.startsWith('/api/'))routes.push({method:m,url:r.url});
 });
}

const D=(tag:string,summary:string,access:Access='session',extra:Partial<Doc>={}):Doc=>({tag,summary,access,...extra});
const docs:Record<string,Doc>={
 'GET /api/health':D('System','Health check','public'),
 'GET /api/metrics':D('System','Prometheus metrics','admin'),
 'GET /api/openapi.json':D('System','This document','admin'),
 'GET /api/auth/status':D('Authentication','Whether the first administrator still has to be created','public'),
 'POST /api/auth/bootstrap':D('Authentication','Create the first administrator','public',{body:'email, password (12+ characters)'}),
 'POST /api/auth/login':D('Authentication','Sign in with a password (and authenticator code, or stepwise for a challenge)','public',{body:'email, password, totp?, stepwise?'}),
 'POST /api/auth/challenge':D('Authentication','Finish sign-in with an authenticator code','public',{body:'challenge, code'}),
 'POST /api/auth/passkey/options':D('Authentication','Start a passkey sign-in (second factor)','public',{body:'challenge'}),
 'POST /api/auth/passkey/verify':D('Authentication','Finish a passkey sign-in','public',{body:'challenge, response'}),
 'POST /api/auth/forgot':D('Authentication','Email a password reset link (always answers ok)','public',{body:'email'}),
 'POST /api/auth/token/accept':D('Authentication','Set a password from an invitation or reset link','public',{body:'token, password'}),
 'POST /api/auth/recover':D('Authentication','Reset a password with a recovery code','public',{body:'email, recoveryCode, password'}),
 'POST /api/auth/logout':D('Authentication','Sign out'),
 'GET /api/auth/me':D('Authentication','The signed-in user','session',{scope:'read'}),
 'GET /api/auth/sessions':D('Authentication','Your signed-in devices'),
 'DELETE /api/auth/sessions/:id':D('Authentication','Sign a device out'),
 'POST /api/auth/sessions/revoke-others':D('Authentication','Sign out everywhere else'),
 'GET /api/auth/passkeys':D('Authentication','Your passkeys'),
 'POST /api/auth/passkeys/options':D('Authentication','Start registering a passkey'),
 'POST /api/auth/passkeys/verify':D('Authentication','Finish registering a passkey',  'session',{body:'response, name?'}),
 'DELETE /api/auth/passkeys/:id':D('Authentication','Remove a passkey'),
 'GET /api/tokens':D('Authentication','API tokens','admin'),
 'POST /api/tokens':D('Authentication','Create an API token (scopes: read, provision, suspend)','admin',{body:'name, scopes[], expiresAt?'}),
 'DELETE /api/tokens/:id':D('Authentication','Revoke an API token','admin'),
 'GET /api/overview':D('Fleet','Counts of nodes, servers and capacity','admin',{scope:'read'}),
 'GET /api/nodes':D('Fleet','List nodes','admin',{scope:'read'}),
 'POST /api/nodes':D('Fleet','Register a node','admin',{scope:'provision',body:'name, location, memoryMb, cpuPercent, diskMb, headroomMb?'}),
 'POST /api/nodes/:id/enrollment':D('Fleet','Create a one-time enrollment token for a node','admin',{scope:'provision'}),
 'PATCH /api/nodes/:id':D('Fleet','Edit a node','admin',{scope:'provision'}),
 'DELETE /api/nodes/:id':D('Fleet','Remove an empty node','admin',{scope:'provision'}),
 'POST /api/nodes/:id/evacuate':D('Fleet','Move every server off a node','admin'),
 'GET /api/customers':D('Customers','List customers with usage and quota','admin',{scope:'read'}),
 'POST /api/customers':D('Customers','Create a customer','admin',{scope:'provision',body:'email, password?'}),
 'GET /api/customers/:id':D('Customers','One customer with usage','admin',{scope:'read'}),
 'PATCH /api/customers/:id':D('Customers','Edit a customer (disabled, password, quota)','admin',{scope:'provision',body:'disabled?, password?, quota? {maxServers,maxMemoryMb,maxCpuPercent,maxDiskMb,maxBackups,maxExtraPorts}'}),
 'POST /api/customers/:id/invite':D('Customers','Email an invitation (or return the link when email is off)','admin'),
 'POST /api/customers/:id/sign-out':D('Customers','Sign a customer out everywhere','admin'),
 'GET /api/account/usage':D('Customers','Your quota and what you use'),
 'GET /api/templates':D('Templates','List templates (customers see no commands or environment values)','session',{scope:'read'}),
 'POST /api/templates':D('Templates','Create a template','admin',{scope:'provision'}),
 'PUT /api/templates/:id':D('Templates','Edit a template (a runtime change creates a new version)','admin',{scope:'provision'}),
 'DELETE /api/templates/:id':D('Templates','Delete an unused custom template','admin',{scope:'provision'}),
 'GET /api/templates/:id/export':D('Templates','Export a template as JSON','admin'),
 'POST /api/templates/import':D('Templates','Import a template document','admin',{scope:'provision',body:'document, id?, overwrite?'}),
 'GET /api/templates/:id/outdated':D('Templates','Servers on an older template version','admin'),
 'POST /api/templates/:id/apply':D('Templates','Recreate servers with the newest template version','admin',{body:'confirm:true, serverIds?'}),
 'GET /api/servers':D('Servers','List servers you can access','session',{scope:'read'}),
 'POST /api/servers':D('Servers','Provision a server','admin',{scope:'provision',body:'name, ownerId, templateId, nodeId?, location?, memoryMb?, cpuPercent?, diskMb?, port?, force?'}),
 'GET /api/servers/:id':D('Servers','One server','session',{scope:'read'}),
 'PATCH /api/servers/:id':D('Servers','Edit name and resources','admin',{scope:'provision'}),
 'DELETE /api/servers/:id':D('Servers','Delete a server and its data','admin',{scope:'provision',body:'confirm:true'}),
 'POST /api/servers/:id/actions':D('Servers','start, stop, restart, kill, suspend, unsuspend, reinstall, backup or restore','session',{scope:'suspend',body:'action, backupId?, confirm?'}),
 'PATCH /api/servers/:id/settings':D('Servers','Change the variables an owner may edit','session',{body:'variables {KEY:value}'}),
 'GET /api/servers/:id/startup':D('Servers','Image, command and environment as the server starts'),
 'POST /api/servers/:id/clone':D('Servers','Clone a server (optionally with data from a backup)','admin',{body:'name, includeData?, backupId?, ownerId?, nodeId?, location?, force?'}),
 'POST /api/servers/:id/migrate':D('Resilience','Move a server to another node'),
 'GET /api/servers/:id/ports':D('Servers','Port mappings'),
 'POST /api/servers/:id/ports':D('Servers','Add an extra port mapping','session',{body:'container, protocol, label?'}),
 'DELETE /api/servers/:id/ports/:offset':D('Servers','Remove an extra port mapping'),
 'GET /api/servers/:id/console':D('Console','Recent console output'),
 'POST /api/servers/:id/console':D('Console','Send a console command','session',{body:'command'}),
 'GET /api/servers/:id/files':D('Files','List a folder','session',{scope:'read'}),
 'GET /api/servers/:id/files/content':D('Files','Read a text file'),
 'PUT /api/servers/:id/files/content':D('Files','Write a text file'),
 'POST /api/servers/:id/files/mkdir':D('Files','Create a folder'),
 'POST /api/servers/:id/files/extract':D('Files','Extract a zip file'),
 'POST /api/servers/:id/files/upload':D('Files','Upload a small file'),
 'GET /api/servers/:id/files/download':D('Files','Download a small file'),
 'POST /api/servers/:id/transfers':D('Files','Start a large upload or download'),
 'POST /api/servers/:id/sftp':D('Files','Create temporary SFTP credentials'),
 'GET /api/servers/:id/backups':D('Backups','List backups'),
 'POST /api/servers/:id/backups':D('Backups','Take a backup'),
 'DELETE /api/servers/:id/backups/:backupId':D('Backups','Delete a backup'),
 'GET /api/servers/:id/backups/:backupId/download':D('Backups','Download a backup'),
 'GET /api/servers/:id/schedules':D('Schedules','List schedules'),
 'POST /api/servers/:id/schedules':D('Schedules','Create a schedule','session',{body:'name?, cron or intervalMinutes, timezone?, tasks[{action:power|command|backup|wait}], missed?, enabled?'}),
 'PATCH /api/servers/:id/schedules/:scheduleId':D('Schedules','Edit a schedule'),
 'DELETE /api/servers/:id/schedules/:scheduleId':D('Schedules','Delete a schedule'),
 'POST /api/servers/:id/schedules/:scheduleId/run':D('Schedules','Run a schedule now'),
 'GET /api/servers/:id/schedules/:scheduleId/runs':D('Schedules','Run history'),
 'GET /api/cron/preview':D('Schedules','Next occurrences of a cron expression'),
 'GET /api/servers/:id/crash-policy':D('Servers','Automatic restart policy and state'),
 'PUT /api/servers/:id/crash-policy':D('Servers','Set the restart policy','session',{body:'mode, maxRestarts, windowMinutes, backoffSeconds[]'}),
 'GET /api/servers/:id/events':D('Servers','Crash and restart history'),
 'GET /api/servers/:id/metrics':D('Servers','CPU and memory history','session',{body:'?range=1h|6h|24h|7d|30d'}),
 'GET /api/servers/:id/collaborators':D('Access','List collaborators'),
 'POST /api/servers/:id/collaborators':D('Access','Add a collaborator (invite:true emails a new account)','session',{body:'email, permissions[], invite?'}),
 'DELETE /api/servers/:id/collaborators/:userId':D('Access','Remove a collaborator'),
 'GET /api/servers/:id/addons':D('Add-ons','Mods and plugins: capability, catalogs, installed'),
 'GET /api/servers/:id/addons/search':D('Add-ons','Search a catalog'),
 'POST /api/servers/:id/addons/plan':D('Add-ons','Preview an install with dependencies'),
 'POST /api/servers/:id/addons/install':D('Add-ons','Install a mod or plugin'),
 'GET /api/servers/:id/addons/updates':D('Add-ons','Available updates'),
 'POST /api/servers/:id/addons/update':D('Add-ons','Apply updates'),
 'GET /api/plugins':D('Plugins','Installed plugins','admin'),
 'GET /api/plugins/store':D('Plugins','Bundled and registry plugins','admin'),
 'POST /api/plugins':D('Plugins','Install a plugin','admin',{body:'source (bundled|registry|upload), id?, package?, acceptPermissions:true'}),
 'POST /api/plugins/inspect':D('Plugins','Look inside a plugin package without installing it','admin'),
 'PATCH /api/plugins/:id':D('Plugins','Turn a plugin on or off','admin',{body:'enabled'}),
 'PUT /api/plugins/:id/settings':D('Plugins','Save plugin settings','admin'),
 'POST /api/plugins/:id/update':D('Plugins','Update a plugin','admin'),
 'POST /api/plugins/:id/rollback':D('Plugins','Return to the previous plugin version','admin'),
 'DELETE /api/plugins/:id':D('Plugins','Uninstall a plugin','admin'),
 'GET /api/notifications':D('Notifications','Your inbox'),
 'GET /api/notifications/summary':D('Notifications','Unread count'),
 'POST /api/notifications/read':D('Notifications','Mark as read'),
 'GET /api/notification-events':D('Notifications','Events you can subscribe to'),
 'GET /api/notification-channels':D('Notifications','Your delivery channels'),
 'POST /api/notification-channels':D('Notifications','Add a channel (webhook, discord, slack, email)','session',{body:'name, kind, url? | to?, events[], serverIds?'}),
 'PATCH /api/notification-channels/:id':D('Notifications','Edit a channel'),
 'DELETE /api/notification-channels/:id':D('Notifications','Remove a channel'),
 'POST /api/notification-channels/:id/test':D('Notifications','Send a test message'),
 'GET /api/activity':D('Audit','Audit log (filters: action, actor, targetType, targetId, from, to, q)','admin',{scope:'read'}),
 'GET /api/activity/export':D('Audit','Export the audit log as CSV or JSON','admin',{body:'?format=csv|json plus the same filters'}),
 'GET /api/settings':D('Settings','Panel settings (secrets are never returned)','admin'),
 'PUT /api/settings/:section':D('Settings','Save a settings section (storage, nodes, agentUpdates, updates, failover, plugins, email, security)','admin'),
 'POST /api/settings/email/test':D('Settings','Send a test email','admin',{body:'to'}),
 'GET /api/failover/status':D('Resilience','Failover readiness and history','admin'),
 'POST /api/failover/plan':D('Resilience','Dry-run a failover','admin'),
 'GET /api/updates':D('Updates','Check for a new Fledge version','admin'),
 'POST /api/updates/run':D('Updates','Install the latest version','admin'),
 'GET /api/agent-releases':D('Updates','Node agent versions','admin'),
 'GET /api/jobs':D('Fleet','Recent jobs','session',{scope:'read'}),
};

const tagOf=(url:string)=>url.split('/')[2]?.replace(/-/g,' ')||'api';
const accessOf=(method:string,url:string):Access=>url.startsWith('/api/agent/')?'agent':(docs[`${method} ${url}`]?.access||'session');

export function buildSpec(){
 const paths:Record<string,any>={};
 for(const {method,url} of routes){
  const key=`${method} ${url}`,d=docs[key],access=accessOf(method,url),tokenScope=tokenScopeFor(method,url);
  const path=url.replace(/:([A-Za-z]+)/g,'{$1}');
  const params=[...url.matchAll(/:([A-Za-z]+)/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
  const op:any={tags:[d?.tag||(access==='agent'?'Node agent protocol':'Undocumented: '+tagOf(url))],summary:d?.summary||(access==='agent'?'Used by node agents':'Undocumented'),
   ...(params.length?{parameters:params}:{}),
   ...(['POST','PUT','PATCH'].includes(method)?{requestBody:{required:false,content:{'application/json':{schema:{type:'object',...(d?.body?{description:d.body}:{})}}}}}:{}),
   responses:{'200':{description:'Success',content:{'application/json':{schema:{type:'object'}}}},'400':{$ref:'#/components/responses/Error'},'401':{$ref:'#/components/responses/Error'},'403':{$ref:'#/components/responses/Error'},'404':{$ref:'#/components/responses/Error'},'409':{$ref:'#/components/responses/Error'}},
   'x-access':access,...(tokenScope?{'x-token-scope':tokenScope}:{})};
  op.security=access==='public'?[]:access==='agent'?[{nodeCredential:[]}]:tokenScope?[{cookieAuth:[]},{bearerAuth:[]}]:[{cookieAuth:[]}];
  (paths[path]??={})[method.toLowerCase()]=op;
 }
 return {openapi:'3.1.0',info:{title:'Fledge API',version:panelVersion(),description:'Fledge control panel API. Browser sessions use the fledge_session cookie. Integrations use bearer API tokens (Settings → API tokens) with the read, provision and suspend scopes; tokens can only reach the endpoints marked with a token scope. Node agents use their own credentials and are not for general use.'},
  servers:[{url:'/'}],paths,
  components:{securitySchemes:{cookieAuth:{type:'apiKey',in:'cookie',name:'fledge_session'},bearerAuth:{type:'http',scheme:'bearer'},nodeCredential:{type:'http',scheme:'bearer',description:'Node credential plus X-Node-ID header'}},
   responses:{Error:{description:'Error',content:{'application/json':{schema:{type:'object',properties:{error:{type:'string'},message:{type:'string'}}}}}}}}};
}
export function openapiRoutes(app:FastifyInstance){
 app.get('/api/openapi.json',async(req)=>{admin(req);return buildSpec();});
}
