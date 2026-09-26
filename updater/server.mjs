import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const port=Number(process.env.PORT||4010);
const tokenFile=process.env.UPDATE_TOKEN_FILE||'/run/fledge-updater/token';
const workspace='/workspace';
const state={state:'idle',phase:'idle',version:null,logs:[],startedAt:null,finishedAt:null,error:null};
let child;
let launching=false;

async function authorized(req){
 try{
  const secret=(await readFile(tokenFile,'utf8')).trim();
  const supplied=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const expected=Buffer.from(secret),received=Buffer.from(supplied);
  return !!secret&&expected.length===received.length&&timingSafeEqual(expected,received);
 }catch{return false;}
}

function projectName(){
 const result=spawnSync('docker',['inspect','--format','{{ index .Config.Labels "com.docker.compose.project" }}',process.env.HOSTNAME||''],{encoding:'utf8',timeout:5000});
 const name=(result.stdout||'').trim();
 if(result.status!==0||!/^[-a-zA-Z0-9_]+$/.test(name))throw new Error('Could not identify this Docker Compose project.');
 return name;
}

function respond(res,status,value){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
function safeState(){return {...state,logs:state.logs.slice(-40)};}
function logLine(line){
 const text=line.trim().slice(0,600);if(!text)return;
 state.logs.push(text);if(state.logs.length>80)state.logs.splice(0,state.logs.length-80);
 const marker=/UPDATE_PROGRESS:([a-z-]+)/.exec(text);if(marker)state.phase=marker[1];
 else if(/Database backup saved/i.test(text))state.phase='backup-complete';
 else if(state.phase==='starting')state.phase='preparing';
}

function launch(version){
 state.state='running';state.phase='starting';state.version=version;state.logs=[];state.startedAt=new Date().toISOString();state.finishedAt=null;state.error=null;
 let project;
 try{project=projectName();}
 catch(error){state.state='failed';state.phase='failed';state.error=error.message;state.finishedAt=new Date().toISOString();return;}
 const env={...process.env,COMPOSE_PROJECT_NAME:project,COMPOSE_FILE:`${workspace}/compose.yaml`,API_HEALTH_URL:'http://api:4000/api/health',WEB_HEALTH_URL:'http://web:3000/'};
 const scriptPath=`${workspace}/update.sh`;
 const normalizeAndRun='set -eu; temp=$(mktemp); trap \'rm -f "$temp"\' EXIT; tr -d "\\r" < "$1" > "$temp"; sh "$temp" "$2"';
 child=spawn('sh',['-c',normalizeAndRun,'fledge-updater',scriptPath,`v${version}`],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
 let buffers={stdout:'',stderr:''};
 for(const channel of ['stdout','stderr'])child[channel].on('data',chunk=>{
  buffers[channel]+=chunk.toString();const lines=buffers[channel].split(/\r?\n/);buffers[channel]=lines.pop()||'';for(const line of lines)logLine(line);
 });
 child.on('error',error=>{state.state='failed';state.phase='failed';state.error=`Could not start the update: ${error.message}`;state.finishedAt=new Date().toISOString();child=undefined;});
 child.on('close',code=>{
  for(const channel of ['stdout','stderr'])logLine(buffers[channel]);
  if(code===0){state.state='succeeded';state.phase='complete';}
  else{state.state='failed';state.phase='failed';state.error=`The update stopped with exit code ${code??'unknown'}. Check the log below.`;}
  state.finishedAt=new Date().toISOString();child=undefined;
 });
}

createServer(async(req,res)=>{
 if(!await authorized(req)){respond(res,401,{error:'Unauthorized'});return;}
 const url=new URL(req.url||'/',`http://${req.headers.host||'updater'}`);
 if(req.method==='GET'&&url.pathname==='/status'){respond(res,200,safeState());return;}
 if(req.method==='POST'&&url.pathname==='/run'){
  if(launching||child||state.state==='running'){respond(res,409,{...safeState(),error:'An update is already running.'});return;}
  launching=true;
  let raw='';try{for await(const chunk of req)raw+=chunk;}catch{launching=false;respond(res,400,{error:'Invalid request body'});return;}
  if(raw.length>2048){launching=false;respond(res,413,{error:'Request too large'});return;}
  let body;try{body=JSON.parse(raw||'{}');}catch{launching=false;respond(res,400,{error:'Invalid JSON'});return;}
  const version=typeof body.version==='string'?body.version.replace(/^v/i,''):'';
  if(!/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.test(version)){launching=false;respond(res,400,{error:'A valid release version is required.'});return;}
  launch(version);launching=false;respond(res,state.state==='running'?202:503,safeState());return;
 }
 respond(res,404,{error:'Not found'});
}).listen(port,'0.0.0.0',()=>console.log(`Fledge updater listening on ${port}`));
