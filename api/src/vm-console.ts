import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {WebSocket,WebSocketServer} from 'ws';
import {createClient} from 'redis';
import {pool,hash,WEB_ORIGIN,fail,asId} from './core.js';

// Desktop bytes have their own bounded relay. They are never console history or
// audit content. Redis is optional and used only for cross-replica pub/sub.
const uuid=/^[a-f0-9-]{36}$/i, digest=/^[a-f0-9]{64}$/;
export async function consoleActor(ticket:string){
 return (await pool.query(`SELECT t.*,s.node_id,s.owner_id FROM vm_console_tickets t JOIN sessions ss ON ss.token_hash=t.session_hash JOIN users u ON u.id=t.user_id JOIN servers s ON s.id=t.server_id JOIN nodes n ON n.id=s.node_id AND n.deleted_at IS NULL LEFT JOIN collaborators c ON c.server_id=s.id AND c.user_id=u.id
 WHERE t.token_hash=$1 AND t.expires_at>now() AND ss.user_id=u.id AND ss.expires_at>now() AND NOT u.disabled AND u.status='active' AND s.runtime='vm' AND s.deleted_at IS NULL AND NOT s.suspended AND s.observed_status='running'
 AND NOT EXISTS(SELECT 1 FROM account_suspensions a WHERE a.user_id=s.owner_id AND a.lifted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM account_suspensions a WHERE a.user_id=u.id AND a.lifted_at IS NULL)
 AND ((u.role='admin' AND u.totp_secret IS NOT NULL AND (u.is_super OR u.admin_permissions IS NULL OR 'servers.console'=ANY(u.admin_permissions))) OR (u.role='customer' AND (s.owner_id=u.id OR c.permissions && ARRAY['console','manage']::text[])))`,[ticket])).rows[0];
}
async function nodeCredential(id:string,bearer:string){return uuid.test(id)&&bearer.startsWith('Bearer ')&&(await pool.query('SELECT 1 FROM nodes WHERE id=$1 AND credential_hash=$2 AND deleted_at IS NULL',[id,hash(bearer.slice(7))])).rowCount;}
export async function registerVMConsole(app:FastifyInstance){
 const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
 const peers=new Map<string,{browser?:WebSocket;agent?:WebSocket;waiting?:Buffer[];waitingBytes?:number;actor?:any}>();
 const redisURL=process.env.VM_REDIS_URL;if(Number(process.env.API_REPLICAS||1)>1&&!redisURL)throw Error('VM_REDIS_URL is required with multiple API replicas');const publisher=redisURL?createClient({url:redisURL}):null,subscriber=publisher?.duplicate();
 if(publisher&&subscriber){publisher.on('error',e=>app.log.error(e,'VM relay Redis'));subscriber.on('error',e=>app.log.error(e,'VM relay Redis subscription'));await publisher.connect();await subscriber.connect();}
 const replica=randomUUID();
 const safeSend=(ws:WebSocket|undefined,data:Buffer)=>{if(!ws||ws.readyState!==WebSocket.OPEN)return false;if(ws.bufferedAmount>1048576){ws.close(1013,'Console connection is too slow');return false};for(let offset=0;offset<data.length;offset+=16384)ws.send(data.subarray(offset,offset+16384),{binary:true});return true};
 const relay=async(id:string,side:'browser'|'agent',data:Buffer)=>{const other=side==='browser'?'agent':'browser',entry=peers.get(id);if(safeSend(entry?.[other],data))return;if(publisher){await publisher.publish(`fledge:vm:${id}:${other}`,JSON.stringify({replica,data:data.toString('base64')}));return;}if(side==='browser'&&entry){entry.waitingBytes=(entry.waitingBytes||0)+data.length;if(entry.waitingBytes>1048576){entry.browser?.close(1008,'Too much traffic before the node connected');return;}(entry.waiting??=[]).push(Buffer.from(data));}};
 const authorizationListener=await pool.connect();
 await authorizationListener.query('LISTEN fledge_vm_revoke');
 authorizationListener.on('notification',notice=>{if(notice.channel!=='fledge_vm_revoke')return;try{const p=JSON.parse(notice.payload||'{}');for(const [id,pair] of peers){const a=pair.actor;if(!a)continue;const matches=(!p.userId||p.userId===a.user_id||p.userId===a.owner_id)&&(!p.serverId||p.serverId===a.server_id)&&(!p.nodeId||p.nodeId===a.node_id)&&(!p.sessionHash||p.sessionHash===a.session_hash);if(matches){pair.browser?.close(1008,'Console access revoked');pair.agent?.close(1008,'Console access revoked');void pool.query('UPDATE vm_console_tickets SET expires_at=now() WHERE token_hash=$1',[id]).catch(()=>{});}}}catch{app.log.error('Invalid VM authorization notification')}});
 authorizationListener.on('error',()=>{for(const pair of peers.values()){pair.browser?.close(1011,'Authorization listener unavailable');pair.agent?.close(1011,'Authorization listener unavailable');}});
 app.get('/api/agent/vm-consoles',async(req)=>{const id=asId(req.headers['x-node-id']);if(!(await nodeCredential(id,req.headers.authorization||'')))fail(401,'Invalid node credential');return {consoles:(await pool.query(`SELECT t.token_hash AS id,t.server_id AS "serverId",t.mode FROM vm_console_tickets t JOIN servers s ON s.id=t.server_id WHERE s.node_id=$1 AND t.used_at IS NOT NULL AND t.expires_at>now() AND s.runtime='vm' AND NOT s.suspended AND s.deleted_at IS NULL`,[id])).rows};});
 app.server.on('upgrade',(req,socket,head)=>{const path=new URL(req.url||'/', 'http://localhost').pathname;const browserMatch=/^\/api\/vm-console\/([A-Za-z0-9_-]{43})$/.exec(path),agentMatch=/^\/api\/agent\/vm-console\/([a-f0-9]{64})$/.exec(path);if(!browserMatch&&!agentMatch)return;
  let claimedTicket:string|null=null;
  void(async()=>{const side=browserMatch?'browser':'agent',id=browserMatch?hash(browserMatch[1]):agentMatch![1];if(!digest.test(id))throw Error('Invalid console ticket');let actor=await consoleActor(id);if(!actor)throw Error('Console access expired');
   if(side==='browser'){if(req.headers.origin!==WEB_ORIGIN||req.headers.authorization)throw Error('Invalid console origin');const session=/(?:^|;\s*)fledge_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];if(!session||hash(decodeURIComponent(session))!==actor.session_hash)throw Error('Console session mismatch');const used=await pool.query("UPDATE vm_console_tickets SET used_at=now(),expires_at=now()+interval '1 hour' WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING token_hash",[id]);if(!used.rowCount)throw Error('Console ticket already used');claimedTicket=id;}
   else{const node=req.headers['x-node-id'];if(typeof node!=='string'||node!==actor.node_id||!(await nodeCredential(node,req.headers.authorization||''))||!actor.used_at)throw Error('Invalid console node');const claimed=await pool.query('UPDATE vm_console_tickets SET agent_connected=true WHERE token_hash=$1 AND NOT agent_connected AND expires_at>now() RETURNING token_hash',[id]);if(!claimed.rowCount)throw Error('Console agent already connected');claimedTicket=id;}
   // Subscribe before opening the socket so the first RFB greeting cannot race
   // a cross-replica subscription. Buffer bounded early frames until upgrade.
   const early:Buffer[]=[];let earlyBytes=0,earlyReady=false;const channel=`fledge:vm:${id}:${side}`;
   if(subscriber)await subscriber.subscribe(channel,raw=>{try{const m=JSON.parse(raw);if(m.replica!==replica&&m.ready===true){const ws=peers.get(id)?.[side];if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({ready:true}));else earlyReady=true;return;}if(m.replica!==replica&&typeof m.data==='string'&&m.data.length<=90000){const bytes=Buffer.from(m.data,'base64');if(!safeSend(peers.get(id)?.[side],bytes)){earlyBytes+=bytes.length;if(earlyBytes>1048576){socket.destroy();return;}early.push(bytes);}}}catch{socket.destroy()}});
   wss.handleUpgrade(req,socket,head,ws=>{const entry=peers.get(id)||{};if(entry[side]){ws.close(1008,'Console already connected');return};entry[side]=ws;entry.actor=actor;peers.set(id,entry);let closed=false,pending=0;if(earlyReady&&actor.mode==='serial')ws.send(JSON.stringify({ready:true}));if(side==='agent'&&actor.mode==='serial'){if(entry.browser?.readyState===WebSocket.OPEN)entry.browser.send(JSON.stringify({ready:true}));else if(publisher)void publisher.publish(`fledge:vm:${id}:browser`,JSON.stringify({replica,ready:true}));}for(const bytes of early)safeSend(ws,bytes);if(side==='agent'){for(const bytes of entry.waiting||[])safeSend(ws,bytes);entry.waiting=[];entry.waitingBytes=0;}

    const check=setInterval(()=>{void consoleActor(id).then(a=>{if(!a||a.node_id!==actor.node_id)ws.close(1008,'Console access revoked');else if(side==='agent')void nodeCredential(actor.node_id,req.headers.authorization||'').then(ok=>ok?ws.ping():ws.close(1008,'Node credential revoked'));else ws.ping();}).catch(()=>ws.close(1011,'Authorization unavailable'));},1000);check.unref();
    const expire=setTimeout(()=>ws.close(1000,'Console session expired'),60*60*1000);expire.unref();
    // Keep the browser handshake pending until the agent connects. noVNC starts
    // by receiving the RFB greeting; it does not send credentials before that.
    ws.on('message',(data,isBinary)=>{if(!isBinary||++pending>64){ws.close(1008,'Invalid or excessive console traffic');return};const bytes=Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer);void relay(id,side,bytes).catch(()=>ws.close(1011,'Relay failed')).finally(()=>pending--);});
    ws.on('error',()=>ws.close());ws.on('close',()=>{if(closed)return;closed=true;clearInterval(check);clearTimeout(expire);if(subscriber)void subscriber.unsubscribe(channel).catch(()=>{});const own=peers.get(id);if(own){delete own[side];own[side==='browser'?'agent':'browser']?.close(1000,'Console peer disconnected');if(!own.browser&&!own.agent)peers.delete(id)};void pool.query('UPDATE vm_console_tickets SET expires_at=now() WHERE token_hash=$1',[id]).catch(()=>{});});
   });
  })().catch(e=>{if(claimedTicket){void pool.query('UPDATE vm_console_tickets SET expires_at=now() WHERE token_hash=$1',[claimedTicket]).catch(()=>{});if(subscriber)void subscriber.unsubscribe(`fledge:vm:${claimedTicket}:${browserMatch?'browser':'agent'}`).catch(()=>{});}app.log.info({reason:e.message},'VM console denied');if(!socket.destroyed)socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
 });
 app.addHook('onClose',async()=>{for(const pair of peers.values()){pair.browser?.terminate();pair.agent?.terminate()}wss.close();await authorizationListener.query('UNLISTEN fledge_vm_revoke').catch(()=>{});authorizationListener.release();await subscriber?.quit();await publisher?.quit()});
}
