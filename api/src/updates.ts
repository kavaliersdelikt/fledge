import type {FastifyInstance} from 'fastify';
import {randomBytes} from 'node:crypto';
import {mkdir, open, readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {admin} from './core.js';

const repository=(process.env.GITHUB_REPOSITORY||'kavaliersdelikt/fledge').trim();
const currentVersion=()=> (process.env.APP_VERSION||'0.1.7').replace(/^v/i,'');
const updater=(process.env.UPDATER_URL||'').replace(/\/$/,'');
const tokenFile=process.env.UPDATE_TOKEN_FILE||'/run/fledge-updater/token';
let cached:{at:number;value:any}|undefined;
const parse=(value:string)=>{const m=/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);return m?[Number(m[1]),Number(m[2]),Number(m[3]),m[4]||'']:null;};
const newer=(candidate:string,current:string)=>{const a=parse(candidate),b=parse(current);if(!a||!b)return false;for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return !a[3]&&!!b[3];};

async function getRelease(force=false){
 if(!force&&cached&&Date.now()-cached.at<5*60_000)return cached.value;
 const releaseUrl=`https://github.com/${repository}/releases/latest`;
 try{
  const headers:Record<string,string>={accept:'application/vnd.github+json','user-agent':'Fledge-update-check'};
  if(process.env.GITHUB_TOKEN)headers.authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
  const request={headers,signal:AbortSignal.timeout(6000)};
  const response=await fetch(`https://api.github.com/repos/${repository}/releases/latest`,request);
  let release:any;
  if(response.ok)release=await response.json();
  else if(response.status===404){
   // Tags are sufficient for the updater, which installs versioned Git tags.
   // This also supports repositories where a tag was pushed but no GitHub
   // Release was published for it.
   const tagsResponse=await fetch(`https://api.github.com/repos/${repository}/tags?per_page=100`,request);
   if(!tagsResponse.ok)throw Object.assign(new Error('github-http'),{status:tagsResponse.status});
   const tags:any=await tagsResponse.json();
   if(!Array.isArray(tags))throw new Error('github-invalid-response');
   const stable=tags.filter((tag:any)=>typeof tag?.name==='string'&&parse(tag.name)&&!parse(tag.name)?.[3]);
   stable.sort((a:any,b:any)=>newer(a.name,b.name)?-1:newer(b.name,a.name)?1:0);
   release=stable[0];
   if(!release)throw Object.assign(new Error('release-not-found'),{status:404});
   release={...release,html_url:`https://github.com/${repository}/releases/tag/${encodeURIComponent(release.name)}`,published_at:release.commit?.commit?.author?.date||null};
  }else throw Object.assign(new Error('github-http'),{status:response.status});
  const tag=typeof release.tag_name==='string'?release.tag_name:release.name;
  const version=typeof tag==='string'?tag.replace(/^v/i,''):'';
  if(!parse(version))throw new Error('github-invalid-response');
  const value={repository,currentVersion:currentVersion(),latestVersion:version,updateAvailable:newer(version,currentVersion()),releaseName:typeof release.name==='string'&&release.name?release.name:`Fledge v${version}`,releaseUrl:typeof release.html_url==='string'?release.html_url:releaseUrl,body:typeof release.body==='string'?release.body.slice(0,12000):'',publishedAt:typeof release.published_at==='string'?release.published_at:null,checkedAt:new Date().toISOString(),error:null};
  cached={at:Date.now(),value};return value;
 }catch(error:any){
  const status=error?.status;
  const errorMessage=status===401||status===404
   ?'GitHub could not find a published release or version tag. Confirm the repository name and publish a versioned tag; private repositories also need a valid GITHUB_TOKEN.'
   :status===403||status===429
    ?'GitHub rate-limited or denied the release check. Wait a few minutes or configure a GitHub token on the API.'
    :status>=500
     ?'GitHub is temporarily unavailable. Try checking for updates again shortly.'
     :'Could not reach GitHub to check for updates. Check the API container’s internet and DNS connectivity.';
  const value={repository,currentVersion:currentVersion(),latestVersion:null,updateAvailable:false,releaseName:null,releaseUrl,body:'',publishedAt:null,checkedAt:new Date().toISOString(),error:errorMessage};
  cached={at:Date.now(),value};return value;
 }
}

async function getToken(){
 await mkdir(dirname(tokenFile),{recursive:true});
 try{return (await readFile(tokenFile,'utf8')).trim();}catch(error:any){if(error?.code!=='ENOENT')throw error;}
 const token=randomBytes(32).toString('hex');
 try{const file=await open(tokenFile,'wx',0o600);try{await file.writeFile(token+'\n');}finally{await file.close();}return token;}
 catch(error:any){if(error?.code==='EEXIST')return (await readFile(tokenFile,'utf8')).trim();throw error;}
}

async function updaterRequest(path:string,method='GET',body?:unknown){
 if(!updater)throw Object.assign(new Error('The in-panel updater is not configured for this installation.'),{statusCode:503});
 const response=await fetch(`${updater}${path}`,{method,headers:{authorization:`Bearer ${await getToken()}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
 let data:any;try{data=await response.json();}catch{data={error:'Updater returned an invalid response.'};}
 return {status:response.status,data};
}

export function registerUpdates(app:FastifyInstance){
 app.get('/api/updates',async(req)=>{
  admin(req);
  const refresh=(req.query as {refresh?:string}).refresh==='1';
  const value=await getRelease(refresh);
  return {...value,oneClickEnabled:!!updater};
 });

 app.get('/api/updates/status',async(req,reply)=>{
  admin(req);
  try{const result=await updaterRequest('/status');reply.code(result.status);return result.data;}
  catch(error:any){reply.code(error?.statusCode||503);return {state:'unavailable',phase:'unavailable',logs:[],error:error?.message||'Updater is unavailable.'};}
 });

 app.post('/api/updates/run',async(req,reply)=>{
  admin(req);
  const release=await getRelease();
  if(release.error||!release.latestVersion){reply.code(503);return {error:release.error||'Latest release could not be checked.'};}
  if(!release.updateAvailable){reply.code(409);return {error:'This panel is already on the latest release.',latestVersion:release.latestVersion};}
  try{
   const result=await updaterRequest('/run','POST',{version:release.latestVersion});
   reply.code(result.status);return result.data;
  }catch(error:any){reply.code(error?.statusCode||503);return {error:error?.message||'Updater is unavailable.'};}
 });
}
