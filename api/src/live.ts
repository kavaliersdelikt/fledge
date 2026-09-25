import {createHash} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import type {FastifyInstance} from 'fastify';
import {pool,WEB_ORIGIN,hash} from './core.js';

// Browser endpoint: wss://API/api/servers/:id/live (cookie, Origin and console grant).
// Node endpoint: wss://API/api/agent/stream (outbound Bearer + X-Node-ID).
// Frames are JSON. Node sends {type:'log',serverId,data:<base64 bytes>} and
// {type:'sample',serverId,cpuPercent,memoryBytes,memoryLimitBytes}. The panel
// receives those plus {type:'status',connected:boolean}. Commands remain on
// the existing authenticated HTTP console endpoint, never on this read stream.
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const guid='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
type Message={type:string;serverId:string;[key:string]:unknown};
class Peer {
 private buffer=Buffer.alloc(0);private fragments:Buffer[]=[];private fragmented=false;
 private finished=false;onMessage:(value:string)=>void=()=>{};onClose:()=>void=()=>{};
 constructor(public socket:Duplex,head:Buffer){socket.on('data',b=>this.feed(b));socket.on('error',()=>this.close());socket.on('end',()=>this.close());socket.on('close',()=>this.close());if(head.length)this.feed(head);}
 send(value:unknown){return this.frame(1,Buffer.from(JSON.stringify(value)));}
 private frame(op:number,payload:Buffer){if(this.finished||this.socket.writableLength>1024*1024){this.close();return false;}const n=payload.length,h=n<126?2:n<65536?4:10;const out=Buffer.allocUnsafe(h+n);out[0]=0x80|op;out[1]=n<126?n:n<65536?126:127;if(h===4)out.writeUInt16BE(n,2);if(h===10)out.writeBigUInt64BE(BigInt(n),2);payload.copy(out,h);this.socket.write(out);return true;}
 private feed(chunk:Buffer){if(this.finished)return;this.buffer=Buffer.concat([this.buffer,chunk]);if(this.buffer.length>256*1024){this.close();return;}while(this.buffer.length>=2){const a=this.buffer[0],b=this.buffer[1],op=a&15,masked=!!(b&128);let len=b&127,header=2;if(len===126){if(this.buffer.length<4)return;len=this.buffer.readUInt16BE(2);header=4;}else if(len===127){if(this.buffer.length<10)return;const big=this.buffer.readBigUInt64BE(2);if(big>BigInt(65536)){this.close();return;}len=Number(big);header=10;}if(!masked||len>65536){this.close();return;}if(this.buffer.length<header+4+len)return;const mask=this.buffer.subarray(header,header+4),data=Buffer.from(this.buffer.subarray(header+4,header+4+len));for(let i=0;i<len;i++)data[i]^=mask[i%4];this.buffer=this.buffer.subarray(header+4+len);if(op>=8){if(!(a&128)||len>125){this.close();return;}if(op===8){this.close();return;}if(op===9)this.frame(10,data);else if(op!==10)this.close();continue;}if(op===1){if(this.fragmented){this.close();return;}this.fragments=[data];this.fragmented=!(a&128);}else if(op===0&&this.fragmented){this.fragments.push(data);if(this.fragments.reduce((n,x)=>n+x.length,0)>65536){this.close();return;}if(a&128)this.fragmented=false;}else{this.close();return;}if(!this.fragmented){const text=Buffer.concat(this.fragments).toString('utf8');this.fragments=[];this.onMessage(text);}}}
 close(){if(this.finished)return;this.finished=true;this.socket.destroy();this.onClose();}
}
function deny(socket:Duplex,code:number){socket.end(`HTTP/1.1 ${code} ${code===403?'Forbidden':'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}
function upgrade(req:IncomingMessage,socket:Duplex,head:Buffer){const key=req.headers['sec-websocket-key'];if(req.headers.upgrade?.toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13'||typeof key!=='string'||Buffer.from(key,'base64').length!==16){deny(socket,400);return null;}const accept=createHash('sha1').update(key+guid).digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);return new Peer(socket,head);}
export function validSample(m:any){return m&&Number.isFinite(m.cpuPercent)&&m.cpuPercent>=0&&m.cpuPercent<=100000&&Number.isSafeInteger(m.memoryBytes)&&m.memoryBytes>=0&&Number.isSafeInteger(m.memoryLimitBytes)&&m.memoryLimitBytes>0;}
export function validLog(m:any){return typeof m?.data==='string'&&m.data.length<=32768&&m.data.length%4===0&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.data);}
const nodes=new Map<string,Peer>();const viewers=new Map<string,Set<Peer>>();const serverNodes=new Map<string,string>();
async function panelAccess(id:string,session:string){const r=await pool.query(`SELECT s.node_id FROM sessions ss JOIN users u ON ss.user_id=u.id JOIN servers s ON s.id=$2 LEFT JOIN collaborators c ON c.user_id=u.id AND c.server_id=s.id WHERE ss.token_hash=$1 AND ss.expires_at>now() AND NOT u.disabled AND (u.role<>'admin' OR u.totp_secret IS NOT NULL) AND s.deleted_at IS NULL AND (u.role='admin' OR u.id=s.owner_id OR c.permissions && ARRAY['console','manage']::text[])`,[hash(session),id]);return r.rows[0] as {node_id:string}|undefined;}
async function nodeAccess(id:string,credential:string){return !!(await pool.query('SELECT 1 FROM nodes WHERE id=$1 AND credential_hash=$2 AND deleted_at IS NULL',[id,hash(credential)])).rowCount;}
export function registerLive(app:FastifyInstance){
 const replica=crypto.randomUUID(),subscriptions=new Map<string,Set<string>>();let cursor='0',polling=false,maintaining=false,ready=false;
 const initialize=pool.query('SELECT coalesce(max(id),0)::text AS id FROM console_events').then(r=>{cursor=r.rows[0].id;ready=true;});
 const pump=setInterval(()=>{if(polling||!ready)return;polling=true;void (async()=>{const rows=(await pool.query('SELECT id::text,server_id,frame FROM console_events WHERE id>$1 ORDER BY id LIMIT 200',[cursor])).rows;for(const row of rows){cursor=row.id;for(const v of viewers.get(row.server_id)||[])v.send(row.frame);}})().catch(e=>app.log.error(e,'console relay')).finally(()=>{polling=false;});},250);pump.unref();
 async function maintain(){if(maintaining)return;maintaining=true;try{
  for(const id of viewers.keys())await pool.query("INSERT INTO console_interests(replica,server_id,expires_at) VALUES($1,$2,now()+interval '30 seconds') ON CONFLICT(replica,server_id) DO UPDATE SET expires_at=excluded.expires_at",[replica,id]);
  for(const [id,peer] of nodes){const lease=await pool.query("UPDATE console_nodes SET expires_at=now()+interval '30 seconds' WHERE node_id=$1 AND replica=$2 RETURNING node_id",[id,replica]);if(!lease.rowCount){peer.close();continue;}const wanted=new Set<string>((await pool.query('SELECT DISTINCT i.server_id FROM console_interests i JOIN servers s ON s.id=i.server_id WHERE i.expires_at>now() AND s.node_id=$1 AND s.deleted_at IS NULL',[id])).rows.map(r=>r.server_id));const prior=subscriptions.get(id)||new Set<string>();for(const serverId of wanted)if(!prior.has(serverId))peer.send({type:'subscribe',serverId});for(const serverId of prior)if(!wanted.has(serverId))peer.send({type:'unsubscribe',serverId});subscriptions.set(id,wanted);}
  await pool.query("DELETE FROM console_events WHERE created_at<now()-interval '2 minutes'");await pool.query('DELETE FROM console_interests WHERE expires_at<now()');await pool.query('DELETE FROM console_nodes WHERE expires_at<now()');
 }finally{maintaining=false;}}
 const maintenance=setInterval(()=>{void maintain().catch(e=>app.log.error(e,'console leases'));},5000);maintenance.unref();
 const connected=async(node:string)=>!!(await pool.query('SELECT 1 FROM console_nodes WHERE node_id=$1 AND expires_at>now()',[node])).rowCount;
 app.addHook('onClose',async()=>{clearInterval(pump);clearInterval(maintenance);for(const p of nodes.values())p.close();for(const set of viewers.values())for(const p of set)p.close();await pool.query('DELETE FROM console_interests WHERE replica=$1',[replica]);await pool.query('DELETE FROM console_nodes WHERE replica=$1',[replica]);});
 app.server.on('upgrade',(req,socket,head)=>{void (async()=>{try{
 await initialize;
 const path=(req.url||'').split('?')[0],panel=/^\/api\/servers\/([a-f\d-]+)\/live$/.exec(path);let peer:Peer|null=null;
 if(panel&&uuid.test(panel[1])){
  if(req.headers.origin!==WEB_ORIGIN||req.headers.authorization){deny(socket,403);return;}
  const session=/(?:^|;\s*)navrylo_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];const access=session&&await panelAccess(panel[1],decodeURIComponent(session));if(!access){deny(socket,403);return;}
  peer=upgrade(req,socket,head);if(!peer)return;const serverId=panel[1],nodeId=access.node_id;let set=viewers.get(serverId);if(!set){set=new Set();viewers.set(serverId,set);}set.add(peer);serverNodes.set(serverId,nodeId);
  peer.onClose=()=>{const members=viewers.get(serverId);members?.delete(peer!);if(!members?.size){viewers.delete(serverId);serverNodes.delete(serverId);void pool.query('DELETE FROM console_interests WHERE replica=$1 AND server_id=$2',[replica,serverId]).catch(()=>{});}};
  peer.send({type:'status',connected:await connected(nodeId)});await maintain();
  const recent=(await pool.query('SELECT frame FROM console_events WHERE server_id=$1 AND id<=$2 ORDER BY id DESC LIMIT 100',[serverId,cursor])).rows.reverse();for(const row of recent)peer.send(row.frame);
  const timer=setInterval(()=>{void panelAccess(serverId,decodeURIComponent(session)).then(async a=>{if(!a||a.node_id!==nodeId)peer?.close();else peer?.send({type:'status',connected:await connected(nodeId)});}).catch(()=>peer?.close());},10000);timer.unref();socket.on('close',()=>clearInterval(timer));return;
 }
 if(path==='/api/agent/stream'){
  const id=req.headers['x-node-id'],bearer=req.headers.authorization||'';
  if(typeof id!=='string'||!uuid.test(id)||!bearer.startsWith('Bearer ')||!(await nodeAccess(id,bearer.slice(7)))){deny(socket,401);return;}
  peer=upgrade(req,socket,head);if(!peer)return;const old=nodes.get(id);old?.close();nodes.set(id,peer);subscriptions.set(id,new Set());
  await pool.query("INSERT INTO console_nodes(node_id,replica,expires_at) VALUES($1,$2,now()+interval '30 seconds') ON CONFLICT(node_id) DO UPDATE SET replica=excluded.replica,expires_at=excluded.expires_at",[id,replica]);await maintain();for(const [serverId,members] of viewers)if(serverNodes.get(serverId)===id)for(const v of members)v.send({type:'status',connected:true});
  let pending=0,writeQueue=Promise.resolve();
  peer.onMessage=text=>{if(++pending>100){pending--;peer?.close();return;}writeQueue=writeQueue.then(async()=>{let m:Message;try{m=JSON.parse(text);}catch{peer?.close();return;}if(!m||!uuid.test(m.serverId)||!subscriptions.get(id)?.has(m.serverId)||nodes.get(id)!==peer)return;let frame:any;if(m.type==='log'&&validLog(m))frame={type:'log',data:m.data};else if(m.type==='sample'&&validSample(m))frame={type:'sample',cpuPercent:m.cpuPercent,memoryBytes:m.memoryBytes,memoryLimitBytes:m.memoryLimitBytes,sampledAt:new Date().toISOString()};else return;
  const valid=await pool.query('SELECT 1 FROM servers s JOIN console_nodes n ON n.node_id=s.node_id WHERE s.id=$1 AND s.node_id=$2 AND s.deleted_at IS NULL AND n.replica=$3 AND n.expires_at>now()',[m.serverId,id,replica]);if(!valid.rowCount)return;
  await pool.query('INSERT INTO console_events(server_id,frame) VALUES($1,$2)',[m.serverId,JSON.stringify(frame)]);if(frame.type==='sample')await pool.query('UPDATE servers SET usage=usage||$1::jsonb WHERE id=$2 AND node_id=$3',[JSON.stringify(frame),m.serverId,id]);
  }).catch(e=>app.log.error(e,'live frame')).finally(()=>{pending--;});};
  peer.onClose=()=>{if(nodes.get(id)===peer){nodes.delete(id);subscriptions.delete(id);void pool.query('DELETE FROM console_nodes WHERE node_id=$1 AND replica=$2',[id,replica]).catch(()=>{});for(const [serverId,members] of viewers)if(serverNodes.get(serverId)===id)for(const v of members)v.send({type:'status',connected:false});}};
  const timer=setInterval(()=>{void nodeAccess(id,bearer.slice(7)).then(ok=>{if(!ok)peer?.close();else peer?.socket.write(Buffer.from([0x89,0x00]));}).catch(()=>peer?.close());},20000);timer.unref();socket.on('close',()=>clearInterval(timer));return;
 }
 deny(socket,404);
 }catch(e){app.log.error(e,'live upgrade');socket.destroy();}})();});
}

