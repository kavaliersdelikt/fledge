import {lookup} from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import {isIP} from 'node:net';
import {createGunzip} from 'node:zlib';

// Outbound fetches the API makes on behalf of administrators (plugin registry, plugin
// packages). HTTPS only, public addresses only, pinned to the vetted address, bounded in
// size and time. The plugin host has the same rules in plugins/host/src/netguard.ts.

export type GuardOptions={allowPrivate?:boolean;allowHttp?:boolean};
export class GuardError extends Error{constructor(message:string){super(message);this.name='GuardError';}}
const v4Blocked:[string,number][]=[['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]];
const toInt=(ip:string)=>ip.split('.').reduce((a,b)=>a*256+Number(b),0);
export function isPrivateAddress(ip:string):boolean{
 const kind=isIP(ip);
 if(kind===4){const n=toInt(ip);return v4Blocked.some(([base,bits])=>{const size=2**(32-bits),start=Math.floor(toInt(base)/size)*size;return n>=start&&n<start+size;});}
 if(kind===6){
  const x=ip.toLowerCase();
  const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);if(mapped)return isPrivateAddress(mapped[1]);
  const hex=/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
  if(hex){const hi=parseInt(hex[1],16),lo=parseInt(hex[2],16);return isPrivateAddress(`${hi>>8}.${hi&255}.${lo>>8}.${lo&255}`);}
  return x==='::'||x==='::1'||/^f[cd]/.test(x)||/^fe[89ab]/.test(x)||/^ff/.test(x)||x.startsWith('64:ff9b:')||x.startsWith('2001:db8');
 }
 return true;
}

/** GET (or POST) a URL and return the body, enforcing the rules above (also on every redirect of a GET). */
export async function safeGet(rawUrl:string,opts:{maxBytes:number;timeoutMs?:number;headers?:Record<string,string>;redirects?:number;hostFilter?:(host:string)=>boolean;method?:'GET'|'POST';body?:string}&GuardOptions):Promise<{status:number;body:Buffer;headers:http.IncomingHttpHeaders}>{
 let url:URL;
 try{url=new URL(rawUrl);}catch{throw new GuardError('Invalid URL');}
 for(let hop=0;hop<=(opts.redirects??3);hop++){
  if(url.protocol!=='https:'&&!(opts.allowHttp&&url.protocol==='http:'))throw new GuardError('Only HTTPS URLs are allowed');
  if(url.username||url.password)throw new GuardError('URLs with credentials are not allowed');
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(opts.hostFilter&&!opts.hostFilter(host))throw new GuardError(`${host} is not an allowed download host`);
  let address:string,family:number;
  if(isIP(host)){address=host;family=isIP(host);}
  else{
   let list;try{list=await lookup(host,{all:true,verbatim:true});}catch{throw new GuardError(`Could not resolve ${host}`);}
   if(!list.length)throw new GuardError(`Could not resolve ${host}`);
   if(!opts.allowPrivate&&list.some(a=>isPrivateAddress(a.address)))throw new GuardError(`${host} resolves to a private or local address`);
   address=list[0].address;family=list[0].family;
  }
  if(!opts.allowPrivate&&isPrivateAddress(address))throw new GuardError('Requests to private or local addresses are not allowed');
  const res=await new Promise<{status:number;body:Buffer;headers:http.IncomingHttpHeaders}>((resolve,reject)=>{
   const mod=url.protocol==='https:'?https:http;
   const req=mod.request({protocol:url.protocol,hostname:url.hostname,port:url.port||undefined,path:url.pathname+url.search,method:opts.method||'GET',headers:{'accept-encoding':'gzip','user-agent':'Fledge-plugin-installer',...(opts.body!==undefined?{'content-length':String(Buffer.byteLength(opts.body))}:{}),...(opts.headers||{})},
    lookup:((_h:string,o:any,cb:any)=>o?.all?cb(null,[{address,family}]):cb(null,address,family)) as any,servername:isIP(url.hostname)?undefined:url.hostname,timeout:opts.timeoutMs??10_000},r=>{
    const stream:NodeJS.ReadableStream=String(r.headers['content-encoding']||'')==='gzip'?r.pipe(createGunzip()):r;
    const chunks:Buffer[]=[];let size=0;
    stream.on('data',(c:Buffer)=>{size+=c.length;if(size>opts.maxBytes){req.destroy();reject(new GuardError(`The download is larger than ${Math.round(opts.maxBytes/1024)} KB`));return;}chunks.push(c);});
    stream.on('end',()=>resolve({status:r.statusCode||0,body:Buffer.concat(chunks),headers:r.headers}));
    stream.on('error',e=>reject(new GuardError(`The download could not be read: ${e.message}`)));
   });
   req.on('timeout',()=>{req.destroy();reject(new GuardError('The request timed out'));});
   req.on('error',e=>reject(e instanceof GuardError?e:new GuardError(`Request failed: ${(e as any).code||e.message}`)));
   if(opts.body!==undefined)req.write(opts.body);
   req.end();
  });
  if(!opts.method||opts.method==='GET'){if([301,302,303,307,308].includes(res.status)&&res.headers.location){try{url=new URL(String(res.headers.location),url);}catch{throw new GuardError('Invalid redirect');}continue;}}
  return res;
 }
 throw new GuardError('Too many redirects');
}

export const safeRequest=safeGet;
