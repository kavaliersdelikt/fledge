// Customer quotas, extra ports and cloning.
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery} from './harness.mjs';
import {randomBytes} from 'node:crypto';

const stack=await bootStack({db:'fledge_fit_smoke',apiPort:4176,hostPort:4524,mock:null});
const admin=client(stack.base);const {call,ok,status,check}=admin;
let failed=null;
const rid=()=>randomBytes(3).toString('hex');
try{
 await bootstrapAdmin(admin);
 const node=await makeNode(admin,'fit','test',{memoryMb:65536,cpuPercent:6400,diskMb:1000000});await heartbeat(admin,node);
 const login=async(c,u)=>ok(await c.call('POST','/api/auth/login',{email:u.email,password:u.temporaryPassword}),'login');
 const mk=async(email='q-'+rid()+'@example.test')=>ok(await call('POST','/api/customers',{email}),'customer');
 const server=async(owner,over={})=>{const s=ok(await call('POST','/api/servers',{name:'S'+rid(),ownerId:owner.id,templateId:'minecraft-paper',nodeId:node.id,memoryMb:1024,cpuPercent:100,diskMb:2048,...over}),'create server');const j=await nextJob(admin,node);if(j&&j.kind==='create')await finishJob(admin,node,j);return s;};

 // --- Quotas --------------------------------------------------------------------------------------------
 const alice=await mk();const aliceC=client(stack.base);await login(aliceC,alice);
 for(const bad of [{maxServers:-1},{maxServers:'many'},{bogus:1},{maxMemoryMb:1.5}])status(await call('PATCH',`/api/customers/${alice.id}`,{quota:bad}),400,'invalid quota '+JSON.stringify(bad));
 const patched=ok(await call('PATCH',`/api/customers/${alice.id}`,{quota:{maxServers:2,maxMemoryMb:2048,maxDiskMb:8192,maxExtraPorts:1,maxBackups:1}}),'set quota');
 check(patched.quota.maxServers===2&&patched.quota.maxExtraPorts===1,'quota is stored');
 const s1=await server(alice),s2=await server(alice);
 const over=await call('POST','/api/servers',{name:'Third',ownerId:alice.id,templateId:'minecraft-paper',nodeId:node.id,memoryMb:512,cpuPercent:100,diskMb:1024});
 status(over,409,'a third server exceeds the server limit');check(/limit of 2 servers/.test(over.data.message),'the message names the limit');
 const detail=ok(await call('GET',`/api/customers/${alice.id}`),'customer detail');
 check(detail.usage.servers===2&&detail.usage.memoryMb===2048&&detail.usage.diskMb===4096,'usage is computed from the customer’s servers');
 const list=ok(await call('GET','/api/customers'),'customer list').find(c=>c.id===alice.id);check(list.usage.servers===2&&list.quota.maxMemoryMb===2048,'the list carries quota and usage');
 status(await call('PATCH',`/api/servers/${s1.id}`,{memoryMb:1536}),409,'growing a server past the memory limit');
 ok(await call('PATCH',`/api/servers/${s1.id}`,{memoryMb:512}),'shrinking is always allowed');
 const cj=await nextJob(admin,node);await finishJob(admin,node,cj);
 ok(await call('PATCH',`/api/servers/${s1.id}`,{memoryMb:1024,force:true}),'admins can force within reason');
 const cj2=await nextJob(admin,node);await finishJob(admin,node,cj2);
 const forced=ok(await call('POST','/api/servers',{name:'Forced',ownerId:alice.id,templateId:'minecraft-paper',nodeId:node.id,memoryMb:512,cpuPercent:100,diskMb:1024,force:true}),'forced create');
 const fj=await nextJob(admin,node);await finishJob(admin,node,fj);
 check(forced.id,'an administrator can deliberately exceed a limit');
 const usage=ok(await aliceC.call('GET','/api/account/usage'),'account usage');check(usage.usage.servers===3&&usage.quota.maxServers===2,'customers can see their limits and usage');
 status(await aliceC.call('PATCH',`/api/customers/${alice.id}`,{quota:{}}),403,'customers cannot edit quotas');
 ok(await call('PATCH',`/api/customers/${alice.id}`,{quota:null}),'clear quota');
 check(Object.keys(ok(await call('GET',`/api/customers/${alice.id}`),'cleared').quota).length===0,'a cleared quota means unlimited');
 ok(await call('PATCH',`/api/customers/${alice.id}`,{quota:{maxServers:10,maxExtraPorts:3,maxBackups:1}}),'quota again');

 // --- Extra ports ---------------------------------------------------------------------------------------------
 const P=`/api/servers/${s1.id}/ports`;
 const ov=ok(await call('GET',P),'ports');check(ov.mappings.length===1&&ov.mappings[0].source==='template'&&ov.mappings[0].hostPort===s1.port,'the template port is listed');
 status(await call('POST',P,{container:70000,protocol:'tcp'}),400,'invalid container port');
 status(await call('POST',P,{container:25575,protocol:'icmp'}),400,'invalid protocol');
 status(await call('POST',P,{container:25565,protocol:'tcp'}),409,'a template port cannot be added twice');
 const added=ok(await call('POST',P,{container:25575,protocol:'tcp',label:'RCON'}),'admin adds a port');
 const OFF=added.added.offset;check(OFF>=3&&added.added.hostPort===s1.port+OFF&&added.restartRequired,'the allocator skips host ports taken by the next server on the node');
 const alloc=await dbQuery(stack.databaseUrl,'SELECT port,protocol FROM allocations WHERE server_id=$1 ORDER BY port',[s1.id]);
 check(alloc.length===2&&alloc[1].port===s1.port+OFF,'the new port is reserved on the node');
 const rj=await nextJob(admin,node);
 check(rj.kind==='configure'&&rj.payload.recreate&&rj.server.internalPorts.length===2&&rj.server.internalPorts.some(p=>p.container===25575&&p.offset===OFF),'the node is told to recreate the container with the extra mapping');
 await finishJob(admin,node,rj);
 status(await call('POST',P,{container:25575,protocol:'tcp'}),409,'duplicate extra port');
 ok(await call('POST',P,{container:25575,protocol:'udp'}),'same number, other protocol is fine');
 const rj2=await nextJob(admin,node);await finishJob(admin,node,rj2);
 // A recreate must never boot a server that is meant to stay stopped (or is suspended).
 await dbQuery(stack.databaseUrl,"UPDATE servers SET desired_status='stopped' WHERE id=$1",[s1.id]);
 const stoppedAdd=ok(await call('POST',P,{container:19000,protocol:'udp'}),'add a port to a stopped server');
 const sj1=await nextJob(admin,node);await finishJob(admin,node,sj1);const sj2=await nextJob(admin,node);
 check(sj1.kind==='configure'&&sj1.payload.recreate&&sj2?.kind==='stop','a stopped server is recreated and then stopped again');
 await finishJob(admin,node,sj2);
 await dbQuery(stack.databaseUrl,"UPDATE servers SET suspended=true WHERE id=$1",[s1.id]);
 status(await call('POST',P,{container:19001,protocol:'udp'}),409,'a suspended server cannot get new ports');
 status(await call('DELETE',`${P}/${stoppedAdd.added.offset}`),409,'or lose them');
 await dbQuery(stack.databaseUrl,"UPDATE servers SET suspended=false,desired_status='running' WHERE id=$1",[s1.id]);
 ok(await call('DELETE',`${P}/${stoppedAdd.added.offset}`),'remove the extra port again');
 const rj3=await nextJob(admin,node);await finishJob(admin,node,rj3);
 // Owners: only within their quota.
 const own=ok(await aliceC.call('GET',`/api/servers/${s2.id}/ports`),'owner overview');check(own.canAdd===true&&own.quota.limit===3&&own.quota.used===2,'an owner with a port quota can add ports');
 ok(await aliceC.call('POST',`/api/servers/${s2.id}/ports`,{container:19132,protocol:'udp',label:'Voice'}),'owner adds a port');
 const oj=await nextJob(admin,node);await finishJob(admin,node,oj);
 aliceC.status(await aliceC.call('POST',`/api/servers/${s2.id}/ports`,{container:19133,protocol:'udp'}),409,'owner is stopped by the quota');
 const bob=await mk();const bobC=client(stack.base);await login(bobC,bob);const bobServer=await server(bob);
 bobC.status(await bobC.call('POST',`/api/servers/${bobServer.id}/ports`,{container:19132,protocol:'udp'}),403,'owners without a port quota need their provider');
 const carol=await mk();const carolC=client(stack.base);await login(carolC,carol);
 carolC.status(await carolC.call('GET',P),404,'strangers cannot see ports');
 aliceC.status(await aliceC.call('DELETE',`${P}/0`),404,'template ports cannot be removed');
 const removed=ok(await call('DELETE',`${P}/${OFF}`),'remove an extra port');check(removed.mappings.filter(m=>m.source==='extra').length===1,'one extra port is left');
 const dj=await nextJob(admin,node);check(dj.kind==='configure'&&dj.server.internalPorts.every(p=>p.offset!==OFF||p.protocol==='udp'),'removal recreates the container without it');await finishJob(admin,node,dj);
 check((await dbQuery(stack.databaseUrl,'SELECT count(*)::int n FROM allocations WHERE server_id=$1 AND port=$2 AND protocol=$3',[s1.id,s1.port+OFF,'tcp']))[0].n===0,'the reservation is released');
 status(await call('DELETE',`${P}/${OFF}`),404,'removing twice');

 ok(await call('PATCH',`/api/customers/${alice.id}`,{quota:{maxServers:10,maxExtraPorts:10}}),'room for clones');
 status(await call('POST',`/api/servers/${s2.id}/clone`,{name:'Tight',ownerId:alice.id,includeData:false,force:false,...{}}),200,'a clone fits the quota now').valueOf();
 const tj=await nextJob(admin,node);await finishJob(admin,node,tj);
 // --- Clone -----------------------------------------------------------------------------------------------------
 const C=`/api/servers/${s1.id}/clone`;
 aliceC.status(await aliceC.call('POST',C,{name:'Mine'}),403,'only administrators can clone');
 status(await call('POST',C,{}),400,'a name is required');
 status(await call('POST',C,{name:'Copy'}),503,'copying data needs object storage');
 const nodata=ok(await call('POST',C,{name:'Copy (settings only)',includeData:false}),'clone without data');
 check(nodata.id!==s1.id&&nodata.templateId==='minecraft-paper'&&nodata.memoryMb===1024&&nodata.port!==s1.port,'the clone has its own port and the original’s resources');
 const cr=await nextJob(admin,node);check(cr.kind==='create'&&cr.server.id===nodata.id&&cr.server.internalPorts.length===2,'the node creates it with the same port layout, extras included');
 check(cr.server.env.RCON_PASSWORD&&cr.server.env.RCON_PASSWORD!==(ok(await call('GET',`/api/servers/${s1.id}`),'orig').variables.RCON_PASSWORD),'the clone gets its own RCON password');
 await finishJob(admin,node,cr);
 // With data: needs object storage and a backup.
 ok(await call('PUT','/api/settings/storage',{enabled:true,endpoint:'http://127.0.0.1:1',region:'us-east-1',bucket:'testbucket',accessKey:'k',secretKey:'s',forcePathStyle:true}),'turn on (dummy) object storage');
 const noBackup=await call('POST',C,{name:'Copy'});status(noBackup,409,'no backup to copy');check(/no successful backup/.test(noBackup.data.message),'the reason is explained');
 const bk=(await dbQuery(stack.databaseUrl,"INSERT INTO backups(server_id,object_key,state) VALUES($1,$2,'succeeded') RETURNING id",[s1.id,'servers/x/backups/y.tar.gz']))[0].id;
 status(await call('POST',C,{name:'Copy',backupId:'00000000-0000-4000-8000-000000000000'}),409,'unknown backup');
 const withData=ok(await call('POST',C,{name:'Copy (with data)'}),'clone with data');check(withData.backupId===bk&&withData.jobs.length===2,'create and restore jobs are queued');
 const cj1=await nextJob(admin,node);check(cj1.kind==='create','create runs first');await finishJob(admin,node,cj1);
 const rest=await nextJob(admin,node);
 check(rest.kind==='restore'&&rest.payload.sourceServerId===s1.id&&rest.payload.backupId===bk&&rest.payload.url,'the restore job reads the original’s backup');
 const dl=await call('GET',`/api/agent/jobs/${rest.id}/backup-object?attempt=${rest.attempt}`,undefined,node.headers);
 check(dl.code!==409,'the node is allowed to fetch the original’s backup for the clone (lease check passed, got '+dl.code+')');
 await finishJob(admin,node,rest);
 // Placement, owners, quotas.
 const carolClone=ok(await call('POST',C,{name:'For Carol',ownerId:carol.id,includeData:false}),'clone for another owner');check(carolClone.ownerId===carol.id,'the clone can belong to someone else');
 const ccj=await nextJob(admin,node);await finishJob(admin,node,ccj);
 ok(await call('PATCH',`/api/customers/${carol.id}`,{quota:{maxServers:1}}),'limit Carol');
 status(await call('POST',C,{name:'Too many',ownerId:carol.id,includeData:false}),409,'the target owner’s quota applies to clones');
 await call('PATCH',`/api/servers/${s2.id}`,{name:'x'});
 ok(await call('POST',`/api/servers/${s2.id}/actions`,{action:'stop'}),'stop a server');const sj=await nextJob(admin,node);await finishJob(admin,node,sj);
 const stoppedClone=ok(await call('POST',`/api/servers/${s2.id}/clone`,{name:'Stopped copy',includeData:false}),'clone a stopped server');
 const sc1=await nextJob(admin,node);await finishJob(admin,node,sc1);const sc2=await nextJob(admin,node);
 check(sc2.kind==='stop'&&sc2.server.id===stoppedClone.id,'a stopped original gives a stopped clone');await finishJob(admin,node,sc2);
 status(await call('POST','/api/servers/00000000-0000-4000-8000-000000000000/clone',{name:'x'}),404,'unknown server');
 const audit=ok(await call('GET','/api/activity?limit=100'),'activity');
 for(const a of ['server.clone','server.port.add','server.port.remove','customer.update'])check(audit.some(x=>x.action===a),'audit trail has '+a);
 console.log(`PASS ${admin.state.count+aliceC.state.count+bobC.state.count+carolC.state.count} assertions: quotas (servers, resources, ports, forced overrides), account usage, extra ports (allocation, node job, owners, removal), clone (settings, data, owner, quota, stopped state)`);
}catch(e){failed=e;}
finally{
 if(failed){console.error('FAIL',failed.message);console.error('--- api log tail ---\n'+stack.api.logs().split('\n').slice(-15).join('\n'));}
 await stack.stop();process.exit(failed?1:0);
}
