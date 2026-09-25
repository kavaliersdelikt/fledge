import type {FastifyInstance} from 'fastify';
import {admin} from './core.js';

const repository=(process.env.GITHUB_REPOSITORY||'kavaliersdelikt/navrylo').trim();
const currentVersion=(process.env.APP_VERSION||'0.1.0').replace(/^v/i,'');
let cached:{at:number;value:any}|undefined;
const parse=(value:string)=>{const m=/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);return m?[Number(m[1]),Number(m[2]),Number(m[3]),m[4]||'']:null;};
const newer=(candidate:string,current:string)=>{const a=parse(candidate),b=parse(current);if(!a||!b)return false;for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return !a[3]&&!!b[3];};

export function registerUpdates(app:FastifyInstance){
 app.get('/api/updates',async(req,reply)=>{
  admin(req);
  const refresh=(req.query as {refresh?:string}).refresh==='1';
  if(cached&&Date.now()-cached.at<60_000)return cached.value;
  if(cached&&!refresh&&Date.now()-cached.at<5*60_000)return cached.value;
  const releaseUrl=`https://github.com/${repository}/releases/latest`;
  try{
   const headers:Record<string,string>={accept:'application/vnd.github+json','user-agent':'Navrylo-update-check'};
   if(process.env.GITHUB_TOKEN)headers.authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
   const response=await fetch(`https://api.github.com/repos/${repository}/releases/latest`,{headers,signal:AbortSignal.timeout(6000)});
   if(!response.ok)throw new Error(response.status===404?'release-not-found':'github-unavailable');
   const release:any=await response.json();
   const version=typeof release.tag_name==='string'?release.tag_name.replace(/^v/i,''):'';
   if(!parse(version))throw new Error('invalid-release');
   const value={repository,currentVersion,latestVersion:version,updateAvailable:newer(version,currentVersion),releaseName:typeof release.name==='string'&&release.name?release.name:`Navrylo v${version}`,releaseUrl:typeof release.html_url==='string'?release.html_url:releaseUrl,body:typeof release.body==='string'?release.body.slice(0,12000):'',publishedAt:typeof release.published_at==='string'?release.published_at:null,checkedAt:new Date().toISOString(),error:null};
   cached={at:Date.now(),value};return value;
  }catch{
   reply.code(200);
   const value={repository,currentVersion,latestVersion:null,updateAvailable:false,releaseName:null,releaseUrl,body:'',publishedAt:null,checkedAt:new Date().toISOString(),error:process.env.GITHUB_TOKEN?'GitHub release lookup failed. Check the repository and GitHub token.':'GitHub release lookup failed. The repository may be private or no release may have been published; configure GITHUB_TOKEN on the API for a private repository.'};
   cached={at:Date.now(),value};return value;
  }
 });
}
