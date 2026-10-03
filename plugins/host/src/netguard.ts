import {lookup} from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import {isIP} from 'node:net';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';

// Outbound HTTP for plugin code. Every request is checked against the plugin's declared
// hosts, must be HTTPS to a public address, is pinned to the address that was checked
// (no DNS rebinding) and is bounded in time and size. Plugins never get a raw socket.

export type GuardOptions={allowPrivate?:boolean;allowHttp?:boolean;/** Test only: send requests for these host names to local servers over plain HTTP. */hostMap?:Record<string,{address:string;port:number}>};
export type FetchInit={method?:string;headers?:Record<string,string>;body?:string};
export type FetchResult={status:number;headers:Record<string,string>;body:string;bytes:number};
export class GuardError extends Error{constructor(message:string,public code='blocked'){super(message);this.name='GuardError';}}

function ipv4ToInt(ip:string){return ip.split('.').reduce((a,b)=>a*256+Number(b),0);}
const v4Blocked:[string,number][]=[['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]];
export function isPrivateAddress(ip:string):boolean{
 const kind=isIP(ip);
 if(kind===4){const n=ipv4ToInt(ip);return v4Blocked.some(([base,bits])=>{const size=2**(32-bits);const start=Math.floor(ipv4ToInt(base)/size)*size;return n>=start&&n<start+size;});}
 if(kind===6){
  const x=ip.toLowerCase();
  const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);if(mapped)return isPrivateAddress(mapped[1]);
  if(x==='::'||x==='::1')return true;
  if(/^f[cd]/.test(x)||/^fe[89ab]/.test(x)||/^ff/.test(x))return true;
  if(x.startsWith('64:ff9b:')||x.startsWith('2001:db8')||x.startsWith('100:'))return true;
  const hexMapped=/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
  if(hexMapped){const hi=parseInt(hexMapped[1],16),lo=parseInt(hexMapped[2],16);return isPrivateAddress(`${hi>>8}.${hi&255}.${lo>>8}.${lo&255}`);}
  return false;
 }
 return true;
}
/** `network:` entries are exact host names or `*.example.com`. */
export function hostAllowed(host:string,allowed:string[]){
 const h=host.toLowerCase();
 return allowed.some(a=>{const p=a.toLowerCase();return p.startsWith('*.')?h.endsWith(p.slice(1))&&h.length>p.length-1:h===p;});
}

const buckets=new Map<string,number[]>();
export function takeRateToken(host:string,perMinute=200,now=Date.now()){
 const list=(buckets.get(host)||[]).filter(t=>now-t<60_000);
 if(list.length>=perMinute){buckets.set(host,list);return false;}
 list.push(now);buckets.set(host,list);return true;
}
export function resetRateLimits(){buckets.clear();}

async function resolvePinned(host:string,opts:GuardOptions){
 if(isIP(host)){
  if(!opts.allowPrivate&&isPrivateAddress(host))throw new GuardError('Requests to private or local addresses are not allowed');
  return {address:host,family:isIP(host)};
 }
 let addrs:{address:string;family:number}[];
 try{addrs=await lookup(host,{all:true,verbatim:true});}catch{throw new GuardError(`Could not resolve ${host}`,'dns');}
 if(!addrs.length)throw new GuardError(`Could not resolve ${host}`,'dns');
 if(!opts.allowPrivate&&addrs.some(a=>isPrivateAddress(a.address)))throw new GuardError(`${host} resolves to a private or local address`);
 return addrs[0];
}

function once(url:URL,init:FetchInit,pinned:{address:string;family:number},limit:number,timeoutMs:number,opts:GuardOptions,mapped?:{address:string;port:number}):Promise<{status:number;headers:http.IncomingHttpHeaders;body:Buffer}>{
 return new Promise((resolve,reject)=>{
  const mod=mapped||url.protocol!=='https:'?http:https;
  const headers:Record<string,string>={'accept-encoding':'gzip, deflate, br',...(init.headers||{})};
  for(const k of Object.keys(headers))if(/^(host|content-length|connection|transfer-encoding|upgrade)$/i.test(k))delete headers[k];
  const body=init.body===undefined?undefined:Buffer.from(init.body);
  if(body)headers['content-length']=String(body.length);
  if(mapped)headers.host=url.hostname;
  const req=mod.request({protocol:mapped?'http:':url.protocol,hostname:mapped?mapped.address:url.hostname,port:mapped?mapped.port:url.port||undefined,path:url.pathname+url.search,method:init.method||'GET',headers,
   // The connection goes to the address that was vetted, never to a second DNS answer.
   lookup:((_h:string,o:any,cb:any)=>o?.all?cb(null,[{address:pinned.address,family:pinned.family}]):cb(null,pinned.address,pinned.family)) as any,
   servername:isIP(url.hostname)?undefined:url.hostname,timeout:timeoutMs},res=>{
   const enc=String(res.headers['content-encoding']||'').toLowerCase();
   let stream:NodeJS.ReadableStream=res;
   if(enc==='gzip')stream=res.pipe(createGunzip());else if(enc==='deflate')stream=res.pipe(createInflate());else if(enc==='br')stream=res.pipe(createBrotliDecompress());
   const chunks:Buffer[]=[];let size=0;
   stream.on('data',(c:Buffer)=>{size+=c.length;if(size>limit){req.destroy();reject(new GuardError(`Response is larger than ${Math.round(limit/1024/1024)} MB`,'too-large'));return;}chunks.push(c);});
   stream.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers,body:Buffer.concat(chunks)}));
   stream.on('error',e=>reject(new GuardError(`Response could not be read: ${e.message}`,'network')));
  });
  req.on('timeout',()=>{req.destroy();reject(new GuardError('The request timed out','timeout'));});
  req.on('error',e=>reject(e instanceof GuardError?e:new GuardError(`Request failed: ${(e as any).code||e.message}`,'network')));
  if(body)req.write(body);
  req.end();
 });
}

export async function guardedFetch(rawUrl:string,init:FetchInit,policy:{hosts:string[];maxBytes:number;timeoutMs:number;maxRedirects?:number;perMinute?:number},opts:GuardOptions={}):Promise<FetchResult>{
 let url:URL;
 try{url=new URL(rawUrl);}catch{throw new GuardError('Invalid URL','url');}
 let method=(init.method||'GET').toUpperCase();
 if(!['GET','HEAD','POST','DELETE'].includes(method))throw new GuardError('Only GET, HEAD, POST and DELETE are allowed','method');
 let current=init;
 for(let hop=0;hop<=(policy.maxRedirects??3);hop++){
  if(url.protocol!=='https:'&&!(opts.allowHttp&&url.protocol==='http:'))throw new GuardError('Only HTTPS URLs are allowed');
  if(url.username||url.password)throw new GuardError('URLs with credentials are not allowed');
  const defaultPort=url.protocol==='https:'?'443':'80';
  if(url.port&&url.port!==defaultPort&&!opts.allowPrivate)throw new GuardError('Only the default HTTPS port is allowed');
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!hostAllowed(host,policy.hosts))throw new GuardError(`This plugin may not contact ${host}. Declared hosts: ${policy.hosts.join(', ')||'none'}`,'host-denied');
  if(!takeRateToken(host,policy.perMinute))throw new GuardError(`Too many requests to ${host}; slow down`,'rate-limit');
  const mapped=opts.hostMap?.[host];
  const pinned=mapped?{address:mapped.address,family:4}:await resolvePinned(host,opts);
  const res=await once(url,current,pinned,policy.maxBytes,policy.timeoutMs,opts,mapped);
  if([301,302,303,307,308].includes(res.status)&&res.headers.location){
   try{url=new URL(String(res.headers.location),url);}catch{throw new GuardError('Invalid redirect','url');}
   if(res.status===303||((res.status===301||res.status===302)&&method==='POST')){method='GET';current={headers:current.headers};}else current={...current,method};
   continue;
  }
  const headers:Record<string,string>={};
  for(const k of ['content-type','etag','last-modified','retry-after','x-ratelimit-remaining','x-ratelimit-limit','x-ratelimit-reset'])if(res.headers[k])headers[k]=String(res.headers[k]);
  return {status:res.status,headers,body:res.body.toString('utf8'),bytes:res.body.length};
 }
 throw new GuardError('Too many redirects','redirect');
}
