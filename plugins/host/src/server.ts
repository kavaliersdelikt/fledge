import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runPlugin,PluginError,type RunInput} from './sandbox.js';

// The plugin host only ever receives requests from the Fledge API (bearer token from a
// shared file). It holds no database credentials and calls nothing in the panel: results,
// logs and storage changes go back in the HTTP response.

const port=Number(process.env.PORT||4020);
const tokenFile=process.env.PLUGIN_TOKEN_FILE||'/run/fledge-plugins/token';
// Test-only switches, deliberately noisy names. Never set in a real deployment.
const hostMap:Record<string,{address:string;port:number}>={};
for(const pair of (process.env.PLUGIN_HOST_UNSAFE_TEST_HOST_MAP||'').split(',').filter(Boolean)){const [name,target]=pair.split('=');const [address,port]=(target||'').split(':');if(name&&address&&port)hostMap[name]={address,port:Number(port)};}
const guard={allowPrivate:process.env.PLUGIN_HOST_UNSAFE_TEST_ALLOW_LOCAL==='1',allowHttp:process.env.PLUGIN_HOST_UNSAFE_TEST_ALLOW_LOCAL==='1',...(Object.keys(hostMap).length?{hostMap}:{})};
const version=process.env.APP_VERSION||'dev';
const codeCache=new Map<string,string>();
let busy=0;const maxBusy=8;
let tokenCache:{at:number;value:string}|undefined;

async function token(){
 if(tokenCache&&Date.now()-tokenCache.at<3000)return tokenCache.value;
 try{const value=(await readFile(tokenFile,'utf8')).trim();tokenCache={at:Date.now(),value};return value;}catch{return '';}
}
async function authorized(req:IncomingMessage){
 const secret=await token();if(!secret)return false;
 const supplied=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 const a=Buffer.from(secret),b=Buffer.from(supplied);
 return a.length===b.length&&timingSafeEqual(a,b);
}
function send(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}
async function readBody(req:IncomingMessage,max:number){
 let size=0;const chunks:Buffer[]=[];
 for await(const chunk of req){size+=chunk.length;if(size>max)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk as Buffer);}
 return Buffer.concat(chunks).toString('utf8');
}
const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');

export const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url||'/',`http://${req.headers.host||'plugins'}`);
  if(req.method==='GET'&&url.pathname==='/health'){
   // Unauthenticated liveness only: used by Compose health checks and installers.
   send(res,200,{ok:true,version,sandbox:'quickjs-wasm'});return;
  }
  if(!await authorized(req)){send(res,401,{error:'Unauthorized'});return;}
  if(req.method==='POST'&&url.pathname==='/invoke'){
   if(busy>=maxBusy){send(res,503,{error:'The plugin host is busy; try again in a moment',code:'busy'});return;}
   let body:any;
   try{body=JSON.parse(await readBody(req,4<<20));}catch(e:any){send(res,e?.status||400,{error:e?.status===413?'Request too large':'Invalid JSON'});return;}
   if(typeof body?.sha!=='string'||!/^[a-f0-9]{64}$/.test(body.sha)||typeof body.method!=='string'||!Array.isArray(body.args)){send(res,400,{error:'sha, method and args are required'});return;}
   let code=codeCache.get(body.sha);
   if(typeof body.code==='string'){
    if(sha256(body.code)!==body.sha){send(res,400,{error:'Code does not match its checksum'});return;}
    const supplied:string=body.code;code=supplied;codeCache.set(body.sha,supplied);if(codeCache.size>64)codeCache.delete(codeCache.keys().next().value as string);
   }
   if(code===undefined){send(res,409,{error:'Plugin code is not cached',need:'code'});return;}
   const input:RunInput={code,method:body.method,args:body.args,settings:body.settings&&typeof body.settings==='object'?body.settings:{},storage:body.storage&&typeof body.storage==='object'?body.storage:{},storageAllowed:body.storageAllowed!==false,network:Array.isArray(body.network)?body.network.filter((h:unknown)=>typeof h==='string').slice(0,20):[],plugin:{id:String(body.plugin?.id||'').slice(0,64),version:String(body.plugin?.version||'').slice(0,40),panelVersion:version},limits:body.limits,guard};
   busy++;
   try{send(res,200,{ok:true,...await runPlugin(input)});}
   catch(e:any){
    if(e instanceof PluginError)send(res,200,{ok:false,error:e.message,code:e.code,logs:e.logs});
    else send(res,500,{ok:false,error:'The plugin host failed',code:'host-error'});
   }finally{busy--;}
   return;
  }
  send(res,404,{error:'Not found'});
 }catch(e:any){send(res,e?.status||500,{error:e?.status?e.message:'Internal error'});}
});
if(process.env.PLUGIN_HOST_NO_LISTEN!=='1')server.listen(port,'0.0.0.0',()=>console.log(`Fledge plugin host listening on ${port}`));
