import net from 'node:net';
import tls from 'node:tls';
import {randomBytes} from 'node:crypto';

export async function liveTests({base,serverId,adminCookie,otherCookie,node1,node2,call}){
 const u=new URL(base);let checks=0;
 function connect(path,headers={}){return new Promise((resolve,reject)=>{
  const sock=u.protocol==='https:'?tls.connect(Number(u.port)||443,u.hostname):net.connect(Number(u.port)||80,u.hostname);
  let buffer=Buffer.alloc(0),handshake=false,queue=[],pending=[];const key=randomBytes(16).toString('base64');let done=false;
  const fail=e=>{if(!done){done=true;reject(e)}for(const p of pending)p.reject(e);pending=[]};
  sock.once('error',fail);sock.on('close',()=>{for(const p of pending)p.reject(Error('socket closed'));pending=[]});
  sock.on('connect',()=>sock.write(`GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n`));
  sock.on('data',data=>{buffer=Buffer.concat([buffer,data]);if(!handshake){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const line=buffer.subarray(0,end).toString().split('\r\n')[0];buffer=buffer.subarray(end+4);handshake=true;done=true;resolve({code:Number(line.split(' ')[1]),close:()=>sock.destroy(),next:()=>new Promise((res,rej)=>{if(queue.length)return res(queue.shift());const entry={resolve:res,reject:rej};pending.push(entry);setTimeout(()=>{const i=pending.indexOf(entry);if(i>=0){pending.splice(i,1);rej(Error('live frame timeout'))}},3000)}),send:message=>{const payload=Buffer.from(JSON.stringify(message)),mask=randomBytes(4),head=Buffer.alloc(8);head[0]=0x81;head[1]=0xfe;head.writeUInt16BE(payload.length,2);mask.copy(head,4);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];sock.write(Buffer.concat([head,payload]))}})}
   while(handshake&&buffer.length>=2){const n=buffer[1]&127;let h=2,length=n;if(n===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);h=4}else if(n===127){if(buffer.length<10)return;length=Number(buffer.readBigUInt64BE(2));h=10}if(buffer.length<h+length)return;const op=buffer[0]&15,payload=buffer.subarray(h,h+length);buffer=buffer.subarray(h+length);if(op===1){const frame=JSON.parse(payload.toString());if(pending.length)pending.shift().resolve(frame);else queue.push(frame)}}
  });
 });}
 async function expect(ws,type,predicate=()=>true){for(let i=0;i<8;i++){let f;try{f=await ws.next()}catch(e){throw Error(`socket closed waiting for ${type}: ${e.message}`)}if(f.type===type&&predicate(f)){checks++;return f}}throw Error(`missing ${type}`)}
 const path=`/api/servers/${serverId}/live`;
 const wrongOrigin=await connect(path,{Origin:'https://evil.invalid',Cookie:adminCookie});if(wrongOrigin.code!==403)throw Error('cross-origin websocket accepted');wrongOrigin.close();checks++;
 const outsider=await connect(path,{Origin:process.env.WEB_ORIGIN||'http://localhost:3000',Cookie:otherCookie});if(outsider.code!==403)throw Error('unauthorized websocket accepted');outsider.close();checks++;
 const badNode=await connect('/api/agent/stream',{'X-Node-ID':node1.id,Authorization:'Bearer bogus'});if(badNode.code!==401)throw Error('invalid node connected');badNode.close();checks++;
 const panel=await connect(path,{Origin:process.env.WEB_ORIGIN||'http://localhost:3000',Cookie:adminCookie});if(panel.code!==101)throw Error('authorized panel rejected');await expect(panel,'status',f=>!f.connected);
 let node=await connect('/api/agent/stream',{'X-Node-ID':node1.id,Authorization:node1.headers.authorization});if(node.code!==101)throw Error('node upgrade rejected');await expect(node,'subscribe',f=>f.serverId===serverId);await expect(panel,'status',f=>f.connected);
 const text=Buffer.from('first line\nsecond line\n');node.send({type:'log',serverId,data:text.subarray(0,7).toString('base64')});node.send({type:'log',serverId,data:text.subarray(7).toString('base64')});const a=await expect(panel,'log'),b=await expect(panel,'log');if(Buffer.concat([Buffer.from(a.data,'base64'),Buffer.from(b.data,'base64')]).compare(text))throw Error('log chunks changed');checks++;
 node.send({type:'sample',serverId,cpuPercent:83.4,memoryBytes:419430400,memoryLimitBytes:536870912});await expect(panel,'sample',f=>f.cpuPercent===83.4&&f.memoryBytes===419430400);const detail=await call('GET',`/api/servers/${serverId}`,undefined,{cookie:adminCookie});if(detail.data.usage?.memoryBytes!==419430400)throw Error('server usage not persisted');checks++;
 node.send({type:'sample',serverId,cpuPercent:-1,memoryBytes:1,memoryLimitBytes:2});await new Promise(r=>setTimeout(r,150));const detail2=await call('GET',`/api/servers/${serverId}`,undefined,{cookie:adminCookie});if(detail2.data.usage?.cpuPercent!==83.4)throw Error('invalid resource sample accepted');checks++;
 const alien=await connect('/api/agent/stream',{'X-Node-ID':node2.id,Authorization:node2.headers.authorization});alien.send({type:'sample',serverId,cpuPercent:99,memoryBytes:1,memoryLimitBytes:2});await new Promise(r=>setTimeout(r,150));const detail3=await call('GET',`/api/servers/${serverId}`,undefined,{cookie:adminCookie});if(detail3.data.usage?.cpuPercent!==83.4)throw Error('foreign node spoofed sample');alien.close();checks++;
 node.close();await expect(panel,'status',f=>!f.connected);node=await connect('/api/agent/stream',{'X-Node-ID':node1.id,Authorization:node1.headers.authorization});await expect(node,'subscribe',f=>f.serverId===serverId);await expect(panel,'status',f=>f.connected);node.close();panel.close();return checks;
}
