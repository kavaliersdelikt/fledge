import type {FastifyInstance} from 'fastify';
import {randomBytes} from 'node:crypto';
import {pool,admin,scope,fail,txt,asId,serverShape,audit} from './core.js';
import {pickNode} from './failover.js';
import {active} from './servers.js';
import {enforceQuota} from './quota.js';
import {backupEnabled} from './storage.js';

// Clone: a new server with the same template, resources, variables and port layout, optionally
// filled from the newest (or a chosen) backup of the original. Placement follows the usual
// rules; the original is not touched.

export function cloneRoutes(app:FastifyInstance){
 app.post('/api/servers/:id/clone',async(req)=>{
  admin(req);scope(req,'provision');
  const b=req.body as any,sourceId=asId((req.params as any).id);
  const name=txt(b?.name,80),includeData=b?.includeData!==false;
  const src=(await pool.query("SELECT s.*,n.location,t.internal_ports,t.image FROM servers s JOIN nodes n ON n.id=s.node_id JOIN templates t ON t.id=s.template_id WHERE s.id=$1 AND s.deleted_at IS NULL",[sourceId])).rows[0];
  if(!src)fail(404,'Server not found');
  active(src);
  const ownerId=b?.ownerId?asId(b.ownerId):src.owner_id;
  const owner=(await pool.query("SELECT id FROM users WHERE id=$1 AND role='customer' AND NOT disabled",[ownerId])).rows[0];
  if(!owner)fail(404,'Active customer not found');
  let backup:any=null;
  if(includeData){
   if(!(await backupEnabled()))fail(503,'Copying data needs object storage (backups). Turn it on in Settings, or clone without data.');
   backup=b?.backupId?(await pool.query("SELECT id,created_at FROM backups WHERE id=$1 AND server_id=$2 AND state='succeeded'",[asId(b.backupId),sourceId])).rows[0]
    :(await pool.query("SELECT id,created_at FROM backups WHERE server_id=$1 AND state='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1",[sourceId])).rows[0];
   if(!backup)fail(409,b?.backupId?'That backup is not available':'This server has no successful backup to copy. Take a backup first, or clone without data.');
  }
  const extras=src.extra_ports||[];
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const r=await pickNode(c,{memory:src.memory_mb,cpu:src.cpu_percent,disk:src.disk_mb,ports:[...src.internal_ports,...extras],location:typeof b?.location==='string'&&b.location?b.location:src.location},{exclude:[],sameLocationOnly:false,preferNode:b?.nodeId?asId(b.nodeId):null});
   if(!r.node)fail(409,`No eligible node: ${r.rejected.join('; ')}`);
   await enforceQuota(ownerId,{servers:1,memoryMb:src.memory_mb,cpuPercent:src.cpu_percent,diskMb:src.disk_mb,extraPorts:extras.length},{db:c,force:b?.force===true,actorIsAdmin:true,change:{server:{memoryMb:src.memory_mb,cpuPercent:src.cpu_percent,diskMb:src.disk_mb},templateId:src.template_id,running:1}});
   const variables={...(src.variables||{})};
   if(variables.RCON_PASSWORD)variables.RCON_PASSWORD=randomBytes(24).toString('base64url');
   const server=(await c.query("INSERT INTO servers(name,owner_id,node_id,template_id,memory_mb,cpu_percent,disk_mb,port,observed_status,variables,template_version,extra_ports,failover_enabled,backup_retention_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'provisioning',$9,$10,$11,$12,$13) RETURNING *",
    [name,ownerId,r.node.id,src.template_id,src.memory_mb,src.cpu_percent,src.disk_mb,r.port,JSON.stringify(variables),src.template_version,JSON.stringify(extras),src.failover_enabled,src.backup_retention_days])).rows[0];
   for(const x of [...src.internal_ports,...extras])await c.query('INSERT INTO allocations(node_id,server_id,port,protocol) VALUES($1,$2,$3,$4)',[r.node.id,server.id,r.port+x.offset,x.protocol]);
   const jobs:string[]=[(await c.query("INSERT INTO jobs(node_id,server_id,kind,created_at) VALUES($1,$2,'create',clock_timestamp()) RETURNING id",[r.node.id,server.id])).rows[0].id];
   if(backup)jobs.push((await c.query("INSERT INTO jobs(node_id,server_id,kind,payload,created_at) VALUES($1,$2,'restore',$3,clock_timestamp()) RETURNING id",[r.node.id,server.id,JSON.stringify({backupId:backup.id,sourceServerId:sourceId,clone:true})])).rows[0].id);
   if(src.desired_status!=='running'){jobs.push((await c.query("INSERT INTO jobs(node_id,server_id,kind,created_at) VALUES($1,$2,'stop',clock_timestamp()) RETURNING id",[r.node.id,server.id])).rows[0].id);await c.query("UPDATE servers SET desired_status='stopped' WHERE id=$1",[server.id]);}
   await c.query('COMMIT');
   await audit(req.actor!.id,'server.clone','server',server.id,{from:sourceId,node:r.node.id,backupId:backup?.id||null,withData:!!backup});
   return {...serverShape({...server,node_name:r.node.name,location:r.node.location,node_status:r.node.status}),jobs,source:sourceId,backupId:backup?.id||null};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 });
}
