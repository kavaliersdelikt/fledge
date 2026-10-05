import {isIP} from 'node:net';
import {pool,fail,asId,txt,positive} from './core.js';

export type VMProfile={vcpus:number;memoryMb:number;diskMb:number;storageMb:number;firmware:'bios'|'uefi';bootOrder?:'installation-first'|'disk-first';secureBoot:boolean;tpm:boolean;diskBus:'virtio'|'sata';nicModel:'virtio'|'e1000';vnc:boolean;serial:boolean;allowPassword:boolean};
export function profileBody(b:any):VMProfile {
 if(!b||typeof b!=='object')fail(400,'Hardware profile required');
 const p:VMProfile={vcpus:positive(b.vcpus,1,64),memoryMb:positive(b.memoryMb,256,1048576),diskMb:positive(b.diskMb,1024,10485760),storageMb:positive(b.storageMb,1024,20971520),firmware:b.firmware,bootOrder:b.bootOrder||'installation-first',secureBoot:b.secureBoot===true,tpm:b.tpm===true,diskBus:b.diskBus,nicModel:b.nicModel,vnc:b.vnc!==false,serial:b.serial!==false,allowPassword:b.allowPassword===true};
 if(!['bios','uefi'].includes(p.firmware)||!['virtio','sata'].includes(p.diskBus)||!['virtio','e1000'].includes(p.nicModel))fail(400,'Invalid firmware or virtual device');
 if(!['installation-first','disk-first'].includes(p.bootOrder!))fail(400,'Invalid boot order');
 if(p.diskMb>p.storageMb)fail(400,'Disk must fit within the storage allowance');
 if(p.secureBoot&&p.firmware!=='uefi')fail(400,'Secure Boot requires UEFI');
 return p;
}
export function mediaBody(b:any){
 const name=txt(b?.name,80),url=txt(b?.url,2048);let u:URL;try{u=new URL(url)}catch{fail(400,'Invalid media URL')}
 if(u!.protocol!=='https:'||u!.username||u!.password||u!.hash)fail(400,'Media requires an HTTPS URL without credentials or a fragment');
 if(!/^[a-f0-9]{64}$/i.test(b?.sha256||''))fail(400,'Expected a SHA-256 checksum');
 if(!['cloud','iso','drivers'].includes(b?.kind)||!['linux','windows'].includes(b?.os))fail(400,'Invalid media kind or operating system');
 if(b.kind==='cloud'&&b.os!=='linux')fail(400,'Cloud-init provisioning requires a Linux cloud image');
 return {name,url,sha256:b.sha256.toLowerCase(),kind:b.kind,os:b.os,sizeBytes:positive(b.sizeBytes,1,32*1024**3),enabled:b.enabled===true};
}
export function keysBody(raw:unknown):string[]{
 if(raw===undefined)return [];
 if(!Array.isArray(raw)||raw.length>20||raw.some(k=>typeof k!=='string'||k.length>8192||!/^ssh-(?:ed25519|rsa) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/.test(k)))fail(400,'Use at most 20 OpenSSH public keys');
 return raw as string[];
}
export async function vmTemplate(raw:any){
 const profileId=asId(raw?.profileId),mediaId=asId(raw?.mediaId),networkId=asId(raw?.networkId);
 const profile=(await pool.query('SELECT * FROM vm_profiles WHERE id=$1 AND enabled',[profileId])).rows[0];
 const media=(await pool.query('SELECT * FROM vm_media WHERE id=$1 AND enabled',[mediaId])).rows[0];
 const network=(await pool.query('SELECT * FROM vm_networks WHERE id=$1 AND enabled',[networkId])).rows[0];
 if(!profile||!media||media.kind==='drivers'||!network)fail(400,'Select an enabled hardware profile, boot image and network');
 if(media.os==='windows'&&(profile.config.firmware!=='uefi'||!profile.config.tpm))fail(400,'Windows profiles require UEFI and TPM');
 const driverId=raw.driverId?asId(raw.driverId):null;
 if(driverId&&!(await pool.query("SELECT 1 FROM vm_media WHERE id=$1 AND enabled AND kind='drivers'",[driverId])).rowCount)fail(400,'Select an enabled driver ISO');
 return {profileId,mediaId,networkId,driverId};
}
export function vmNodeBlocker(n:any,p:VMProfile,network:any):string|null {
 if(n.vm_enabled!==true)return 'VM hosting is disabled for this node in the panel';
 const v=n.agent?.virtualization;
 if(!v?.enabled||!v.kvm||!v.libvirt||v.arch!=='amd64')return 'KVM/libvirt is not ready';
 if(p.firmware==='uefi'&&!v.uefi)return 'UEFI firmware is unavailable';
 if(p.secureBoot&&!v.secureBoot)return 'Secure Boot firmware is unavailable';
 if(p.tpm&&!v.tpm)return 'TPM emulator is unavailable';
 if(!network.node_ids.includes(n.id)||!v.networks?.includes(network.libvirt_name))return 'The VM network is not configured on this node';
 if(!v.nft||!v.isolation)return 'VM isolation requires working nftables ingress filters and bridge isolation';
 return null;
}
export function networkBody(b:any){
 if(!['nat','routed'].includes(b?.mode)||!isIP(String(b?.gateway||''))||!Number.isInteger(b.prefix)||b.prefix<1||b.prefix>(isIP(b.gateway)===4?32:128))fail(400,'Invalid network mode, gateway or prefix');
 if(b.mode==='nat'&&isIP(b.gateway)!==4)fail(400,'NAT networks use IPv4; choose routed for IPv6');
 if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(b?.libvirtName||''))fail(400,'Invalid libvirt network name');
 if(!Array.isArray(b.nodeIds)||!b.nodeIds.length||b.nodeIds.length>100)fail(400,'Select eligible nodes');
 const nodeIds=[...new Set(b.nodeIds.map(asId))];
 if(!Array.isArray(b.dns)||!b.dns.length||b.dns.length>4||b.dns.some((x:any)=>!isIP(x)))fail(400,'Use one to four DNS addresses');
 if(!Array.isArray(b.addresses)||!b.addresses.length||b.addresses.length>4096||b.addresses.some((x:any)=>!isIP(x)||isIP(x)!==isIP(b.gateway)||x===b.gateway))fail(400,'Supply up to 4096 guest addresses, excluding the gateway');
 return {name:txt(b.name,80),libvirtName:b.libvirtName,mode:b.mode,nodeIds,gateway:b.gateway,prefix:b.prefix,dns:b.dns,addresses:[...new Set(b.addresses)],enabled:b.enabled===true};
}
