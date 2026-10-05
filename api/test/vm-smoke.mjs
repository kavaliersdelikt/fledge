// Real HTTP/PostgreSQL contract checks. Node job acknowledgements are simulated;
// hypervisor execution is covered separately by the Linux guest tests.
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery} from './harness.mjs';
import {WebSocket} from 'ws';
import {spawn} from 'node:child_process';
import {waitFor} from './harness.mjs';
import {createHash} from 'node:crypto';
const stack=await bootStack({db:'fledge_vm_smoke',apiPort:4191,hostPort:4541,mock:null,apiEnv:{S3_BUCKET:'vm-contract-tests',S3_ACCESS_KEY:'test',S3_SECRET_KEY:'test',S3_ENDPOINT:'http://127.0.0.1:9',SWEEP_INTERVAL_MS:'500',SLOW_SWEEP_MS:'500',...(process.env.VM_TEST_REDIS?{VM_REDIS_URL:process.env.VM_TEST_REDIS,API_REPLICAS:'2'}:{})}});
const admin=client(stack.base),{call,ok,status,check}=admin;
let browserSocket,agentSocket,replica;let replicaBase=stack.base;
if(process.env.VM_TEST_REDIS){replicaBase='http://127.0.0.1:4193';replica=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:new URL('..',import.meta.url),env:{...process.env,DATABASE_URL:stack.databaseUrl,ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',WEB_ORIGIN:'http://localhost:3000',PORT:'4193',PLUGIN_TOKEN_FILE:stack.tokenFile,PLUGIN_HOST_URL:'http://127.0.0.1:4541',VM_REDIS_URL:process.env.VM_TEST_REDIS,API_REPLICAS:'2'},stdio:'ignore'});try{await waitFor(replicaBase+'/api/health',90000)}catch(e){replica.kill();await stack.stop();throw e}}

const websocket=(path,headers,base=stack.base)=>new WebSocket(base.replace('http:','ws:')+path,{headers});
const opened=ws=>new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
const denied=ws=>new Promise((resolve,reject)=>{ws.once('unexpected-response',(_,res)=>{check(res.statusCode===403,'WebSocket denial');res.resume();ws.terminate();resolve()});ws.once('open',()=>reject(Error('unauthorized console opened')));ws.on('error',()=>{})});
try{
 await bootstrapAdmin(admin);const user=ok(await call('POST','/api/customers',{email:'vm-owner@example.test'}),'owner'),owner=client(stack.base);
 owner.ok(await owner.call('POST','/api/auth/login',{email:user.email,password:user.temporaryPassword}),'owner login');
 const node=await makeNode(admin,'VM node'),target=await makeNode(admin,'VM migration target');await heartbeat(admin,node);await heartbeat(admin,target);
 const media=ok(await call('POST','/api/virtualization/media',{name:'Approved ISO',kind:'iso',os:'linux',url:'https://example.org/install.iso',sha256:'a'.repeat(64),sizeBytes:1048576,enabled:true}),'media');
 status(await call('POST','/api/virtualization/media',{name:'Bad',kind:'iso',os:'linux',url:'http://127.0.0.1/file',sha256:'a'.repeat(64),sizeBytes:1}),400,'HTTP media refused');
 const profile=ok(await call('POST','/api/virtualization/profiles',{name:'Linux',enabled:true,config:{vcpus:2,memoryMb:2048,diskMb:2048,storageMb:8192,firmware:'bios',diskBus:'virtio',nicModel:'virtio',vnc:true,serial:true}}),'profile');
 const network=ok(await call('POST','/api/virtualization/networks',{name:'Guests',libvirtName:'fledge-guests',mode:'nat',nodeIds:[node.id,target.id],gateway:'10.90.0.1',prefix:24,dns:['1.1.1.1'],addresses:['10.90.0.10','10.90.0.11'],enabled:true}),'network');
 const template=ok(await call('POST','/api/templates',{id:'vm-test',name:'Linux VM',runtime:'vm',vm:{mediaId:media.id,profileId:profile.id,networkId:network.id}}),'template');check(template.runtime==='vm','VM template runtime');
 const create=()=>call('POST','/api/servers',{ownerId:user.id,templateId:template.id,name:'Linux VM'});
 status(await create(),409,'non KVM node rejected');
 ok(await call('POST','/api/agent/heartbeat',{version:'0.9.1.1',agent:{os:'linux',arch:'amd64',virtualization:{enabled:true,kvm:true,libvirt:true,arch:'amd64',nft:true,isolation:true,networks:['fledge-guests']}}},node.headers),'VM capability heartbeat');
 const server=ok(await create(),'VM create');check(server.runtime==='vm','runtime in server shape');const vmGrants=owner.ok(await owner.call('GET',`/api/servers/${server.id}`),'VM effective grants').effectivePermissions;check(['view','console','files','backups','manage','vm.configure','vm.network','vm.media','vm.snapshots'].every(p=>vmGrants.includes(p)),'VM owners retain comprehensive management grants');const vmCollaboratorUser=ok(await call('POST','/api/customers',{email:'vm-config@example.test'}),'VM collaborator user');owner.ok(await owner.call('POST',`/api/servers/${server.id}/collaborators`,{email:vmCollaboratorUser.email,permissions:['vm.configure']}),'grant VM configuration');const vmCollaborator=client(stack.base);vmCollaborator.ok(await vmCollaborator.call('POST','/api/auth/login',{email:vmCollaboratorUser.email,password:vmCollaboratorUser.temporaryPassword}),'VM collaborator login');check(vmCollaborator.ok(await vmCollaborator.call('GET',`/api/jobs?serverId=${server.id}`),'VM collaborator jobs').length>0,'VM-only grant can inspect VM jobs');const job=await nextJob(admin,node);check(job.server.runtime==='vm'&&job.server.vm.address==='10.90.0.10','typed job and allocated address');check(ok(await call('GET',`/api/agent/servers/${server.id}/vm-authorization?jobId=${job.id}&attempt=${job.attempt}`,undefined,node.headers),'fresh VM authorization').allowed,'active job authorization');await finishJob(admin,node,job,true,{status:'running'});check(!ok(await call('GET',`/api/agent/servers/${server.id}/vm-authorization?jobId=${job.id}&attempt=${job.attempt}`,undefined,node.headers),'finished authorization').allowed,'finished lease cannot boot guest');
 check((ok(await call('GET','/api/servers/'+server.id),'server')).runtime==='vm','detail runtime');
 for(const path of ['files','startup','console','sftp','addons'])status(await owner.call(path==='sftp'?'POST':'GET',`/api/servers/${server.id}/${path}`,path==='sftp'?{}:undefined),409,'container-only '+path);
 status(await owner.call('POST',`/api/servers/${server.id}/vm/disks`,{sizeMb:1024}),409,'running VM disk edit denied');
 const ticket=owner.ok(await owner.call('POST',`/api/servers/${server.id}/vm/console-ticket`,{mode:'vnc'}),'console ticket');check(ticket.ticket.length===43,'single use ticket entropy');
 await denied(websocket('/api/vm-console/'+ticket.ticket,{Cookie:owner.cookie,Origin:'https://wrong.example'}));
 browserSocket=websocket('/api/vm-console/'+ticket.ticket,{Cookie:owner.cookie,Origin:'http://localhost:3000'});await opened(browserSocket);
 await denied(websocket('/api/vm-console/'+ticket.ticket,{Cookie:owner.cookie,Origin:'http://localhost:3000'}));
 const relayID=createHash('sha256').update(ticket.ticket).digest('hex');agentSocket=websocket('/api/agent/vm-console/'+relayID,node.headers,replicaBase);await opened(agentSocket);if(replica)await denied(websocket('/api/agent/vm-console/'+relayID,node.headers));
 const received=new Promise((resolve,reject)=>{browserSocket.once('message',(data,binary)=>{check(binary&&data.toString()==='RFB 003.008\n','binary console relay');resolve()});setTimeout(()=>reject(Error('relay timed out')),5000).unref()});agentSocket.send(Buffer.from('RFB 003.008\n'));await received;
 const closed=new Promise((resolve,reject)=>{browserSocket.once('close',resolve);setTimeout(()=>reject(Error('permission revocation did not close console')),3000).unref()});
 await dbQuery(stack.databaseUrl,"UPDATE users SET disabled=true WHERE id=$1",[user.id]);await closed;
 browserSocket=null;agentSocket.terminate();agentSocket=null;
 await dbQuery(stack.databaseUrl,"UPDATE users SET disabled=false WHERE id=$1",[user.id]);
 const info=owner.ok(await owner.call('GET',`/api/servers/${server.id}/vm`),'VM info');check(!JSON.stringify(info).includes(media.url)&&!('password' in info.config),'VM response excludes media URL and password');
 status(await call('PUT','/api/templates/vm-test',{name:'Changed',runtime:'container'}),409,'runtime immutable');
 status(await call('POST','/api/templates/import',{document:{format:'fledge-template',formatVersion:1,template:{id:'vm-test',name:'Overwrite',runtime:'container'}},overwrite:true}),409,'import cannot change runtime');
 await dbQuery(stack.databaseUrl,"UPDATE servers SET observed_status='stopped',desired_status='stopped' WHERE id=$1",[server.id]);
 owner.ok(await owner.call('POST',`/api/servers/${server.id}/vm/disks`,{sizeMb:1024}),'add disk');const diskJob=await nextJob(admin,node);check(diskJob.kind==='vm.disks'&&diskJob.server.vm.disks.length===2,'disk job');await finishJob(admin,node,diskJob,true,{status:'stopped'});
 owner.ok(await owner.call('POST',`/api/servers/${server.id}/vm/snapshots`,{name:'Before change'}),'snapshot');const snapshot=await nextJob(admin,node);await finishJob(admin,node,snapshot,true,{status:'stopped'});
 check(owner.ok(await owner.call('GET',`/api/servers/${server.id}/vm`),'snapshot info').snapshots[0].state==='ready','snapshot committed after acknowledgement');
 status(await owner.call('POST',`/api/servers/${server.id}/vm/network`,{rules:[{hostPort:80,guestPort:22,protocol:'tcp'}]}),403,'unallocated ports denied');
 const second=ok(await create(),'second VM');check(second.runtime==='vm','second address');status(await create(),409,'address exhaustion');
 const failedCreate=await nextJob(admin,node);check(failedCreate.kind==='create','second VM provisioning job');await finishJob(admin,node,failedCreate,false,{provisioningCleaned:true});check((await dbQuery(stack.databaseUrl,'SELECT server_id FROM vm_addresses WHERE address=$1',['10.90.0.11']))[0].server_id===null,'confirmed partial provisioning releases IP');const replacement=ok(await create(),'replacement after confirmed cleanup');check(replacement.runtime==='vm','capacity reused after confirmed cleanup');
 const replacementJob=await nextJob(admin,node);await finishJob(admin,node,replacementJob,true,{status:'running'});
 ok(await call('POST','/api/agent/heartbeat',{version:'0.9.1.1',agent:{os:'linux',arch:'amd64',virtualization:{enabled:true,kvm:true,libvirt:true,arch:'amd64',nft:true,isolation:true,networks:['fledge-guests']}}},target.headers),'target capabilities');
 check(owner.ok(await owner.call('GET',`/api/servers/${server.id}/vm/migration-targets`),'owner migration targets').targets.some(t=>t.nodeId===target.id&&t.preservesAddress),'compatible same-pool owner target');
 const move=owner.ok(await owner.call('POST',`/api/servers/${server.id}/vm/migrate`,{nodeId:target.id}),'owner stopped migration');
 const finalBackup=await nextJob(admin,node);check(finalBackup.kind==='backup','migration requires final backup');await finishJob(admin,node,finalBackup,true,{sizeBytes:1024});
 let restoring;for(let i=0;i<80;i++){restoring=await nextJob(admin,target);if(restoring)break;await new Promise(r=>setTimeout(r,250))}
 check(restoring?.kind==='restore'&&restoring.server.vm.address==='10.90.0.10','backup move preserves address and typed restore');await finishJob(admin,target,restoring,true,{status:'stopped',snapshots:[{id:snapshot.payload.snapshotId,name:'Recovered before change',sizeMb:2048}]});
 check(owner.ok(await owner.call('GET',`/api/servers/${server.id}/vm`),'restored snapshot inventory').snapshots.some(s=>s.name==='Recovered before change'&&Number(s.size_mb)===2048),'restored snapshot inventory reconciled');
 const finalStop=await nextJob(admin,target);check(finalStop?.kind==='stop','stopped desired state preserved after restore');await finishJob(admin,target,finalStop,true,{status:'stopped'});
 for(let i=0;i<80;i++){const rows=await dbQuery(stack.databaseUrl,"SELECT state FROM failover_events WHERE server_id=$1 ORDER BY started_at DESC LIMIT 1",[server.id]);if(rows[0]?.state==='completed')break;await new Promise(r=>setTimeout(r,250))}
 check((await dbQuery(stack.databaseUrl,"SELECT state FROM failover_events WHERE server_id=$1 ORDER BY started_at DESC LIMIT 1",[server.id]))[0].state==='completed','offline migration completed');
 check((await dbQuery(stack.databaseUrl,"SELECT 1 FROM jobs WHERE node_id=$1 AND kind='evict' AND payload->>'serverId'=$2",[node.id,server.id])).length===1,'source evicted only after successful target restore');
 const eventIds=ok(await call('GET','/api/notification-events'),'events').map(e=>e.id);for(const event of ['suspension.created','suspension.lifted','support.agent_replied','support.abuse_reported','vm.snapshot_created','vm.provisioned'])check(eventIds.includes(event),'event catalogue '+event);
 const held=ok(await call('POST',`/api/customers/${user.id}/suspend`,{reason:'review',message:'Review in progress'}),'suspension');status(await owner.call('GET',`/api/servers/${server.id}/vm`),403,'suspension gate');check(!ok(await call('GET',`/api/agent/servers/${server.id}/vm-authorization`,undefined,target.headers),'held authorization').allowed,'held guest cannot boot');
 check((await dbQuery(stack.databaseUrl,"SELECT 1 FROM notifications WHERE user_id=$1 AND kind='suspension.created'",[user.id])).length===1,'customer suspension event');
 console.log('VM API smoke passed');
}catch(e){console.error(stack.api.logs());throw e}finally{browserSocket?.terminate();agentSocket?.terminate();replica?.kill();await stack.stop()}
