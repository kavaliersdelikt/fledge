// A small stand-in for api.modrinth.com and cdn.modrinth.com used by the plugin tests. It
// speaks the same JSON shapes as the real API (checked against the live service) so the
// bundled Modrinth plugins run unchanged against it.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';

const bytes=name=>Buffer.from(`fixture jar for ${name}`);
const sha512=b=>createHash('sha512').update(b).digest('hex'),sha1=b=>createHash('sha1').update(b).digest('hex');
export const fileBytes=bytes;
export const fileSha512=name=>sha512(bytes(name));

const project=(id,slug,title,types,cats,over={})=>({id,slug,title,project_type:'mod',all_project_types:types,description:`${title} summary`,body:`## ${title}\n\nA **fixture** project.`,categories:cats,additional_categories:[],client_side:'optional',server_side:'optional',downloads:1000,followers:10,icon_url:`https://cdn.modrinth.com/data/${id}/icon.png`,license:{id:'MIT',name:'MIT License',url:null},updated:'2026-09-01T00:00:00Z',published:'2026-01-01T00:00:00Z',gallery:[{url:`https://cdn.modrinth.com/data/${id}/images/1.png`,title:'Screenshot'}],source_url:'https://github.com/example/'+slug,issues_url:null,wiki_url:null,discord_url:null,...over});
const projects=[
 project('LITHIUM1','lithium','Lithium',['mod'],['fabric','quilt','optimization'],{downloads:5000}),
 project('FABAPI01','fabric-api','Fabric API',['mod'],['fabric','library'],{downloads:9000}),
 project('CLIENTMD','sodium-client','Client Only Mod',['mod'],['fabric'],{client_side:'required',server_side:'unsupported',downloads:100}),
 project('FORGEMD1','forge-thing','Forge Thing',['mod'],['forge'],{downloads:50}),
 project('LUCKPERM','luckperms','LuckPerms',['mod','plugin'],['paper','spigot','bukkit','folia','management'],{downloads:7000}),
 project('VAULT001','vault','Vault',['plugin'],['paper','spigot','bukkit','economy'],{downloads:3000}),
 project('FOLIAONL','folia-only','Folia Only Plugin',['plugin'],['folia'],{downloads:20}),
];
const ver=(id,projectId,number,type,date,gv,loaders,file,deps=[])=>({id,project_id:projectId,name:`${number}`,version_number:number,version_type:type,date_published:date,game_versions:gv,loaders,status:'listed',downloads:100,changelog:`Changes in ${number}`,files:[{id:'f'+id,hashes:{sha512:fileSha512(file),sha1:sha1(bytes(file))},url:`https://cdn.modrinth.com/data/${projectId}/versions/${id}/${encodeURIComponent(file)}`,filename:file,primary:true,size:bytes(file).length}],dependencies:deps});
export const versions=[
 ver('LITH-OLD','LITHIUM1','0.21.3','release','2026-02-01T00:00:00Z',['1.21.11'],['fabric','quilt'],'lithium-fabric-0.21.3+mc1.21.11.jar',[{project_id:'FABAPI01',version_id:null,dependency_type:'required',file_name:null}]),
 ver('LITH-NEW','LITHIUM1','0.21.4','release','2026-03-01T00:00:00Z',['1.21.11'],['fabric','quilt'],'lithium-fabric-0.21.4+mc1.21.11.jar',[{project_id:'FABAPI01',version_id:null,dependency_type:'required',file_name:null},{project_id:'CLIENTMD',version_id:null,dependency_type:'optional',file_name:null}]),
 ver('LITH-BETA','LITHIUM1','0.22.0-beta.1','beta','2026-04-01T00:00:00Z',['1.21.11'],['fabric'],'lithium-fabric-0.22.0-beta.1+mc1.21.11.jar',[{project_id:'FABAPI01',version_id:null,dependency_type:'required',file_name:null}]),
 ver('LITH-120','LITHIUM1','0.11.2','release','2025-01-01T00:00:00Z',['1.20.1'],['fabric'],'lithium-fabric-0.11.2+mc1.20.1.jar'),
 ver('FABAPI-1','FABAPI01','0.100.0','release','2026-03-02T00:00:00Z',['1.21.11'],['fabric'],'fabric-api-0.100.0+1.21.11.jar'),
 ver('CLIENT-1','CLIENTMD','1.0.0','release','2026-03-03T00:00:00Z',['1.21.11'],['fabric'],'client-only-1.0.0.jar'),
 ver('FORGE-1','FORGEMD1','1.0.0','release','2026-03-04T00:00:00Z',['1.21.11'],['forge'],'forge-thing-1.0.0.jar'),
 ver('LP-5','LUCKPERM','5.4.0','release','2026-03-05T00:00:00Z',['1.21.11'],['paper','spigot','bukkit'],'LuckPerms-Bukkit-5.4.0.jar',[{project_id:'VAULT001',version_id:null,dependency_type:'optional',file_name:null}]),
 ver('LP-5F','LUCKPERM','5.4.0','release','2026-03-05T00:00:00Z',['1.21.11'],['folia'],'LuckPerms-Folia-5.4.0.jar'),
 ver('VAULT-1','VAULT001','1.7.3','release','2026-03-06T00:00:00Z',['1.21.11'],['paper','spigot','bukkit'],'Vault-1.7.3.jar'),
 ver('FOLIA-1','FOLIAONL','1.0.0','release','2026-03-07T00:00:00Z',['1.21.11'],['folia'],'folia-only-1.0.0.jar'),
];
const cdnFiles=new Map(versions.flatMap(v=>v.files.map(f=>[`/data/${v.project_id}/versions/${v.id}/${encodeURIComponent(f.filename)}`,f.filename])));

const matchVersions=(list,q)=>{
 const loaders=q.loaders?JSON.parse(q.loaders):null,gv=q.game_versions?JSON.parse(q.game_versions):null;
 return list.filter(v=>(!loaders||v.loaders.some(l=>loaders.includes(l)))&&(!gv||v.game_versions.some(g=>gv.includes(g)))).sort((a,b)=>b.date_published.localeCompare(a.date_published));
};
function search(q){
 const facets=q.facets?JSON.parse(q.facets):[];
 let hits=projects.filter(p=>facets.every(group=>group.some(f=>{
  const [k,v]=f.split(':');
  if(k==='project_type')return p.all_project_types.includes(v);
  if(k==='categories')return p.categories.includes(v);
  if(k==='versions')return versions.some(x=>x.project_id===p.id&&x.game_versions.includes(v));
  if(k==='server_side')return p.server_side===v;
  return false;
 })));
 const term=(q.query||'').toLowerCase();
 if(term)hits=hits.filter(p=>p.title.toLowerCase().includes(term)||p.slug.includes(term));
 hits=hits.sort((a,b)=>b.downloads-a.downloads);
 const offset=Number(q.offset||0),limit=Number(q.limit||10);
 return {hits:hits.slice(offset,offset+limit).map(p=>({project_id:p.id,project_type:p.project_type,slug:p.slug,author:'tester',title:p.title,description:p.description,categories:p.categories,display_categories:p.categories,versions:[],downloads:p.downloads,follows:p.followers,icon_url:p.icon_url,date_modified:p.updated,client_side:p.client_side,server_side:p.server_side})),offset,limit,total_hits:hits.length};
}

export async function startMock(){
 const calls=[];
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://mock'),q=Object.fromEntries(url.searchParams);
  calls.push({method:req.method,path:url.pathname,ua:req.headers['user-agent']||'',host:req.headers.host});
  const send=(status,body,type='application/json')=>{res.writeHead(status,{'content-type':type});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
  if(cdnFiles.has(url.pathname))return send(200,bytes(cdnFiles.get(url.pathname)),'application/java-archive');
  if(url.pathname==='/')return send(200,{about:'mock',documentation:'x',name:'modrinth-mock',version:'9.9.9'});
  if(url.pathname==='/v2/tag/loader')return send(200,[{icon:'',name:'fabric',supported_project_types:['mod']},{icon:'',name:'paper',supported_project_types:['plugin']}]);
  if(url.pathname==='/v2/search')return send(200,search(q));
  if(url.pathname==='/v2/tag/category')return send(200,[{icon:'',name:'optimization',project_type:'mod',header:'categories'},{icon:'',name:'management',project_type:'mod',header:'categories'},{icon:'',name:'16x',project_type:'resourcepack',header:'resolutions'}]);
  let m=/^\/v2\/project\/([^/]+)\/version$/.exec(url.pathname);
  if(m){const p=projects.find(x=>x.id===m[1]||x.slug===m[1]);if(!p)return send(404,{error:'not_found'});return send(200,matchVersions(versions.filter(v=>v.project_id===p.id),q));}
  m=/^\/v2\/project\/([^/]+)$/.exec(url.pathname);
  if(m){const p=projects.find(x=>x.id===m[1]||x.slug===m[1]);return p?send(200,p):send(404,{error:'not_found'});}
  m=/^\/v2\/version\/([^/]+)$/.exec(url.pathname);
  if(m){const v=versions.find(x=>x.id===m[1]);return v?send(200,v):send(404,{error:'not_found'});}
  if(url.pathname==='/v2/version_files/update'&&req.method==='POST'){
   let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    const body=JSON.parse(raw),out={};
    for(const h of body.hashes){
     const have=versions.find(v=>v.files.some(f=>f.hashes.sha512===h));if(!have)continue;
     const best=matchVersions(versions.filter(v=>v.project_id===have.project_id),{loaders:body.loaders?JSON.stringify(body.loaders):undefined,game_versions:body.game_versions?JSON.stringify(body.game_versions):undefined})[0];
     if(best)out[h]=best;
    }
    send(200,out);
   });return;
  }
  send(404,{error:'not_found'});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {port:server.address().port,calls,close:()=>new Promise(r=>server.close(r))};
}
