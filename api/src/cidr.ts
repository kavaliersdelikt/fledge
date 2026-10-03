import {BlockList,isIP} from 'node:net';

// IP allow-lists: single addresses or CIDR ranges, IPv4 and IPv6.

function parse(entry:string):{addr:string;prefix:number;family:'ipv4'|'ipv6'}|null{
 const [addr,rawPrefix,...rest]=entry.trim().split('/');
 if(rest.length||!addr)return null;
 const kind=isIP(addr);
 if(!kind)return null;
 const max=kind===4?32:128;
 let prefix=max;
 if(rawPrefix!==undefined){
  if(!/^\d{1,3}$/.test(rawPrefix))return null;
  prefix=Number(rawPrefix);
  if(prefix<0||prefix>max)return null;
 }
 return {addr,prefix,family:kind===4?'ipv4':'ipv6'};
}
export const validCidr=(entry:string)=>parse(entry)!==null;

/** True when `ip` (as reported by the socket, possibly IPv4-mapped IPv6) is inside any entry. */
export function ipAllowed(ip:string|undefined,entries:string[]):boolean{
 if(!entries.length)return true;
 if(!ip)return false;
 const list=new BlockList();
 for(const e of entries){const p=parse(e);if(p)list.addSubnet(p.addr,p.prefix,p.family);}
 const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
 const addr=mapped?mapped[1]:ip;
 const kind=isIP(addr);
 if(!kind)return false;
 return list.check(addr,kind===4?'ipv4':'ipv6');
}
