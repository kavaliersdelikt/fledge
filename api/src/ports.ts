import type {FastifyInstance} from 'fastify';
import {pool,fail,txt,serverAccess,audit,queueRecreate} from './core.js';
import {active} from './servers.js';
import {enforceQuota,usageOf,type Quota} from './quota.js';

// Extra port mappings per server (query ports, voice, RCON, ...). They are stored as offsets
// from the server's base port, exactly like the template's own ports, so planned moves and
// failover re-allocate them on the new node without special cases.

type Extra={container:number;offset:number;protocol:'tcp'|'udp';label?:string};
const MAX_EXTRA=20;
const isManager=(req:any,s:any)=>req.actor?.role==='admin'||s.owner_id===req.actor?.id||(s.permissions||[]).includes('manage');

async function overview(req:any,s:any){
 const t=(await pool.query('SELECT internal_ports FROM templates WHERE id=$1',[s.template_id])).rows[0];
 const node=(await pool.query('SELECT public_host FROM nodes WHERE id=$1',[s.node_id])).rows[0];
 const extras:Extra[]=s.extra_ports||[];
 const quota=((await pool.query('SELECT quota FROM users WHERE id=$1',[s.owner_id])).rows[0]?.quota||{}) as Quota;
 const used=(await usageOf(s.owner_id)).extraPorts;
 const limit=quota.maxExtraPorts===undefined||quota.maxExtraPorts===null?null:quota.maxExtraPorts;
 const admin=req.actor?.role==='admin';
 return {basePort:s.port,publicHost:node?.public_host||null,
  mappings:[...(t.internal_ports as any[]).map(p=>({source:'template',container:p.container,offset:p.offset,hostPort:s.port+p.offset,protocol:p.protocol,label:null,removable:false})),...extras.map(p=>({source:'extra',container:p.container,offset:p.offset,hostPort:s.port+p.offset,protocol:p.protocol,label:p.label||null,removable:true}))],
  quota:{limit,used},canAdd:isManager(req,s)&&(admin||(limit!==null&&used<limit))&&extras.length<MAX_EXTRA};
}

export function portRoutes(app:FastifyInstance){
 app.get('/api/servers/:id/ports',async(req)=>overview(req,await serverAccess(req,(req.params as any).id)));
 app.post('/api/servers/:id/ports',async(req)=>{
  const s=active(await serverAccess(req,(req.params as any).id)),b=req.body as any;
  if(!isManager(req,s))fail(403,'Manage permission required');
  if(s.node_status!=='connected')fail(503,'The server’s node is offline');
  const container=Number(b?.container),protocol=b?.protocol;
  if(!Number.isInteger(container)||container<1||container>65535)fail(400,'container must be a port from 1 to 65535');
  if(!['tcp','udp'].includes(protocol))fail(400,'protocol must be tcp or udp');
  const label=b?.label===undefined||b?.label===''?undefined:txt(b.label,40);
  if(req.actor!.role!=='admin'){
   const quota=(await pool.query('SELECT quota FROM users WHERE id=$1',[s.owner_id])).rows[0]?.quota as Quota;
   if(quota?.maxExtraPorts===undefined||quota?.maxExtraPorts===null)fail(403,'Only your provider can add ports to this server');
  }
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const row=(await c.query('SELECT * FROM servers WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[s.id])).rows[0];
   if(!row)fail(404,'Server not found');
   if(row.suspended)fail(409,'Server is suspended');
   const t=(await c.query('SELECT internal_ports FROM templates WHERE id=$1',[row.template_id])).rows[0];
   const extras:Extra[]=row.extra_ports||[];
   if(extras.length>=MAX_EXTRA)fail(409,`A server can have at most ${MAX_EXTRA} extra ports`);
   if([...(t.internal_ports as any[]),...extras].some(p=>p.container===container&&p.protocol===protocol))fail(409,`${protocol.toUpperCase()} port ${container} is already mapped`);
   await enforceQuota(row.owner_id,{extraPorts:1},{db:c,force:req.actor!.role==='admin'});
   const taken=new Set([...(t.internal_ports as any[]),...extras].map(p=>p.offset));
   let offset=0;
   for(let o=1;o<=100&&!offset;o++){
    if(taken.has(o)||row.port+o>65535)continue;
    const ins=await c.query('INSERT INTO allocations(node_id,server_id,port,protocol) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING port',[row.node_id,row.id,row.port+o,protocol]);
    if(ins.rowCount)offset=o;
   }
   if(!offset)fail(409,'No free port is left next to this server’s base port on its node');
   const entry:Extra={container,offset,protocol,...(label?{label}:{})};
   const upd=(await c.query('UPDATE servers SET extra_ports=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING *',[row.id,JSON.stringify([...extras,entry])])).rows[0];
   await queueRecreate(c,row);
   await c.query('COMMIT');
   await audit(req.actor!.id,'server.port.add','server',row.id,{container,protocol,hostPort:row.port+offset});
   return {...(await overview(req,{...s,...upd,permissions:s.permissions})),added:{...entry,hostPort:row.port+offset},restartRequired:true};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 });
 app.delete('/api/servers/:id/ports/:offset',async(req)=>{
  const s=active(await serverAccess(req,(req.params as any).id)),offset=Number((req.params as any).offset);
  if(!isManager(req,s))fail(403,'Manage permission required');
  if(s.node_status!=='connected')fail(503,'The server’s node is offline');
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const row=(await c.query('SELECT * FROM servers WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[s.id])).rows[0];
   if(!row)fail(404,'Server not found');
   if(row.suspended)fail(409,'Server is suspended');
   const extras:Extra[]=row.extra_ports||[],gone=extras.find(p=>p.offset===offset);
   if(!gone)fail(404,'That extra port does not exist (ports from the template cannot be removed)');
   await c.query('DELETE FROM allocations WHERE server_id=$1 AND port=$2 AND protocol=$3',[row.id,row.port+offset,gone!.protocol]);
   const upd=(await c.query('UPDATE servers SET extra_ports=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING *',[row.id,JSON.stringify(extras.filter(p=>p.offset!==offset))])).rows[0];
   await queueRecreate(c,row);
   await c.query('COMMIT');
   await audit(req.actor!.id,'server.port.remove','server',row.id,{container:gone!.container,protocol:gone!.protocol});
   return {...(await overview(req,{...s,...upd,permissions:s.permissions})),restartRequired:true};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 });
 // What the signed-in customer may use and has used.
 app.get('/api/account/usage',async(req)=>{
  const q=(await pool.query('SELECT quota FROM users WHERE id=$1',[req.actor!.id])).rows[0];
  return {quota:q?.quota||{},usage:await usageOf(req.actor!.id)};
 });
}
