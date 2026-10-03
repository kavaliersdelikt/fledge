import {randomBytes} from 'node:crypto';
import {pool,fail,positive,serverShape,audit} from './core.js';
import {imageAllowed} from './settings.js';
import {enforceQuota} from './quota.js';
import {emitHook} from './plugins/manager.js';

// Creating a server: pick a node with room and free ports, reserve everything in one transaction
// and queue the create job. Used by the administrator's route, by customers creating their own
// servers and by the store fulfilling a paid order, so all of them place servers the same way.

export type ProvisionInput={
 ownerId:string;templateId:string;name:string;
 location?:string|null;nodeId?:string|null;port?:unknown;
 memoryMb?:unknown;cpuPercent?:unknown;diskMb?:unknown;
 force?:boolean;actorId:string|null;actorIsAdmin:boolean;
 createdVia:'admin'|'self'|'store';subscriptionId?:string|null;
 /** Extra template variables to set at creation (already validated by the caller). */
 variables?:Record<string,string>;
 /** Customers get a plain message instead of per-node reasons. */
 friendlyErrors?:boolean;
 /** Restricts the nodes considered to these locations (null = any). */
 locations?:string[]|null;
 /** Skips the owner's limits (used for servers a plan pays for). */
 planBacked?:boolean;
 /** Skips the check that the customer exists and is active (used when the caller already did it). */
 owner?:{id:string};
};

export async function provisionServer(i:ProvisionInput){
 const t=(await pool.query('SELECT * FROM templates WHERE id=$1',[i.templateId])).rows[0];
 if(!t)fail(404,'Template not found');
 if(!(await imageAllowed(t.image)))fail(403,'Template image is not currently allowlisted');
 const memory=positive(i.memoryMb??t.memory_mb),cpu=positive(i.cpuPercent??t.cpu_percent),disk=positive(i.diskMb??t.disk_mb);
 const owner=(await pool.query("SELECT id FROM users WHERE id=$1 AND role='customer' AND NOT disabled AND status='active'",[i.ownerId])).rows[0];
 if(!owner)fail(404,'Active customer not found');
 const ports=t.internal_ports as Array<{offset:number,protocol:string,container:number}>;
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const nodes=(await c.query('SELECT * FROM nodes WHERE ($1::uuid IS NULL OR id=$1) AND ($2::text IS NULL OR location=$2) AND ($4::text[] IS NULL OR location=ANY($4)) AND status=$3 AND NOT draining AND deleted_at IS NULL ORDER BY (memory_mb-headroom_mb) DESC,id FOR UPDATE',[i.nodeId||null,i.location||null,'connected',i.locations||null])).rows;
  let chosen:any,port=0;const rejection:any[]=[];
  await enforceQuota(i.ownerId,{servers:1,memoryMb:memory,cpuPercent:cpu,diskMb:disk},{db:c,force:i.force===true,actorIsAdmin:i.actorIsAdmin,planBacked:i.planBacked,change:{server:{memoryMb:memory,cpuPercent:cpu,diskMb:disk},templateId:i.templateId,running:1}});
  for(const n of nodes){
   const used=(await c.query('SELECT coalesce(sum(memory_mb),0) AS mem,coalesce(sum(cpu_percent),0) AS cpu,coalesce(sum(disk_mb),0) AS disk FROM servers WHERE node_id=$1 AND deleted_at IS NULL',[n.id])).rows[0];
   if(Number(used.mem)+memory>n.memory_mb-n.headroom_mb||Number(used.cpu)+cpu>n.cpu_percent||Number(used.disk)+disk>n.disk_mb){rejection.push({nodeId:n.id,reason:'insufficient reserved capacity'});continue;}
   if(Number.isFinite(Number(n.usage?.diskFreeMb))&&Number(n.usage.diskFreeMb)<disk+n.headroom_mb){rejection.push({nodeId:n.id,reason:'insufficient actual free disk'});continue;}
   const occupied=new Set((await c.query('SELECT port,protocol FROM allocations WHERE node_id=$1',[n.id])).rows.map((x:any)=>`${x.port}/${x.protocol}`));
   const start=i.port===undefined?20000:positive(i.port,1024,65535),end=i.port===undefined?50000:start;
   for(let p=start;p<=end;p++){if(ports.every(x=>p+x.offset<=65535&&!occupied.has(`${p+x.offset}/${x.protocol}`))){chosen=n;port=p;break;}}
   if(chosen)break;
   rejection.push({nodeId:n.id,reason:'no compatible free ports'});
  }
  if(!chosen){
   if(i.friendlyErrors)fail(409,'There is no capacity for this server right now. Try another location or come back a little later.');
   fail(409,`No eligible node: ${JSON.stringify(rejection.length?rejection:[{reason:'no connected node in selected location/pool'}])}`);
  }
  const base=i.templateId==='valheim'?{SERVER_PASS:randomBytes(18).toString('base64url')}:t.image.startsWith('itzg/minecraft-server:')?{RCON_PASSWORD:randomBytes(24).toString('base64url')}:{};
  const variables={...base,...(i.variables||{})};
  const server=(await c.query('INSERT INTO servers(name,owner_id,node_id,template_id,memory_mb,cpu_percent,disk_mb,port,observed_status,variables,template_version,created_via,subscription_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
   [i.name,i.ownerId,chosen.id,i.templateId,memory,cpu,disk,port,'provisioning',JSON.stringify(variables),t.version,i.createdVia,i.subscriptionId||null])).rows[0];
  for(const x of ports)await c.query('INSERT INTO allocations(node_id,server_id,port,protocol) VALUES($1,$2,$3,$4)',[chosen.id,server.id,port+x.offset,x.protocol]);
  const job=(await c.query("INSERT INTO jobs(node_id,server_id,kind) VALUES($1,$2,'create') RETURNING id,state",[chosen.id,server.id])).rows[0];
  await c.query('COMMIT');
  await audit(i.actorId,'server.create','server',server.id,{nodeId:chosen.id,placement:'selected by capacity and port availability',rejected:rejection,via:i.createdVia,...(i.subscriptionId?{subscriptionId:i.subscriptionId}:{})});
  emitHook('server.created',{serverId:server.id,templateId:i.templateId,name:i.name,nodeId:chosen.id});
  return {server,node:chosen,job,rejection,shape:{...serverShape({...server,node_name:chosen.name,location:chosen.location,node_status:chosen.status}),job,placement:{selected:chosen.id,rejected:i.friendlyErrors?[]:rejection}}};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
