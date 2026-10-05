// Import metadata for an actual disposable guest. This never fabricates a guest
// framebuffer or claims TCG is KVM. VM_MANIFEST must come from the agent's vm.json.
import {readFileSync,writeFileSync} from 'node:fs';
import {makeNode,dbQuery} from '../../api/test/harness.mjs';

export async function seedVM(demo, ownerId) {
  if(!process.env.VM_MANIFEST)throw Error('VM_MANIFEST must identify a real running disposable guest');
  const actual=JSON.parse(readFileSync(process.env.VM_MANIFEST,'utf8'));
  if(actual.runtime!=='vm'||!actual.vm?.media?.SHA256||!actual.id)throw Error('Invalid real guest manifest');
  const {c,stack}=demo,ok=c.ok;
  const node=await makeNode(c,'vm-verification','Local verification',{memoryMb:4096,cpuPercent:400,diskMb:32768});
  const media=ok(await c.call('POST','/api/virtualization/media',{name:'Alpine Linux 3.23.3 installation ISO',kind:'iso',os:'linux',url:'https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/alpine-virt-3.23.3-x86_64.iso',sha256:actual.vm.media.SHA256,sizeBytes:actual.vm.media.size_bytes,enabled:true}),'real guest media');
  const profile=ok(await c.call('POST','/api/virtualization/profiles',{name:'Linux verification guest',enabled:true,config:actual.vm.profile}),'guest profile');
  const network=ok(await c.call('POST','/api/virtualization/networks',{name:'Isolated verification network',mode:'nat',libvirtName:'fledge-guests',nodeIds:[node.id],gateway:'10.90.0.1',prefix:24,dns:['1.1.1.1'],addresses:[actual.vm.address],enabled:true}),'guest network');
  ok(await c.call('POST','/api/templates',{id:'linux-vm',name:'Linux virtual machine',runtime:'vm',vm:{profileId:profile.id,mediaId:media.id,networkId:network.id}}),'guest template');
  const config={...actual.vm,sshKeys:actual.vm.sshKeys||[],forwards:actual.vm.forwards||[],media,mediaId:media.id,profile:profile.config,network,networkId:network.id,driver:null,driverId:null};
  // Placement correctly rejects this TCG-only node. Import the already running
  // guest fixture rather than falsely reporting a hardware KVM capability.
  await dbQuery(stack.databaseUrl,"INSERT INTO servers(id,name,owner_id,node_id,template_id,runtime,vm_config,memory_mb,cpu_percent,disk_mb,port,desired_status,observed_status) VALUES($1,'Alpine Linux',$2,$3,'linux-vm','vm',$4,$5,$6,$7,25000,'running','running')",[actual.id,ownerId,node.id,JSON.stringify(config),actual.memoryMb,actual.cpuPercent,actual.diskMb]);
  await dbQuery(stack.databaseUrl,'UPDATE vm_addresses SET server_id=$1 WHERE network_id=$2 AND address=$3',[actual.id,network.id,actual.vm.address]);
  const heartbeat=async()=>ok(await c.call('POST','/api/agent/heartbeat',{version:'0.9.1.1',agent:{os:'linux',arch:'amd64',virtualization:{enabled:true,kvm:false,libvirt:true,arch:'amd64',nft:true,isolation:true,networks:['fledge-guests']}},servers:[{id:actual.id,status:'running',diskEnforced:false}]},node.headers),'verification node');
  await heartbeat();const timer=setInterval(()=>heartbeat().catch(()=>{}),5000);timer.unref();
  if(process.env.VM_RELAY_CONFIG)writeFileSync(process.env.VM_RELAY_CONFIG,JSON.stringify({API:stack.base.replace('127.0.0.1','host.docker.internal').replace('localhost','host.docker.internal'),NodeID:node.id,Credential:node.headers.authorization.slice(7)}),{mode:0o600});
  return {id:actual.id,node,stop:()=>clearInterval(timer)};
}
