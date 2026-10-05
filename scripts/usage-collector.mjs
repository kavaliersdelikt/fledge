import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {openUsageReport,validateUsageReport} from '../shared/usage-envelope.ts';
export function updateUsageState(state,report,now=new Date(),receipt=0){
 validateUsageReport(report);const cutoff=new Date(now.getTime()-29*86400000).toISOString().slice(0,10),tomorrow=new Date(now.getTime()+86400000).toISOString().slice(0,10);
 if(report.day<cutoff||report.day>tomorrow)return state;
 state={schema:1,reports:{...(state?.reports||{})},withdrawn:{...(state?.withdrawn||{})},...(state?.cursor?{cursor:state.cursor}:{})};
 for(const [id,days] of Object.entries(state.reports)){for(const day of Object.keys(days))if(day<cutoff)delete days[day];if(!Object.keys(days).length)delete state.reports[id]}
 for(const [id,day] of Object.entries(state.withdrawn))if(day<cutoff)delete state.withdrawn[id];
 if(report.kind==='withdraw'){delete state.reports[report.id];state.withdrawn[report.id]=now.toISOString().slice(0,10)}
 else if(!state.withdrawn[report.id]){state.reports[report.id]??={};const previous=state.reports[report.id][report.day];if(receipt>=(previous?.receipt||0))state.reports[report.id][report.day]={version:report.version,receipt};}
 return state;
}
export function usageSummary(state,now=new Date()){
 const today=now.toISOString().slice(0,10),windows={day:0,week:6,month:29},summary={asOf:today,active:{},versions:{},daily:{}};
 for(const [name,days] of Object.entries(windows)){
  const cutoff=new Date(now.getTime()-days*86400000).toISOString().slice(0,10);let count=0,versions={};
  for(const records of Object.values(state.reports||{})){const latest=Object.keys(records).filter(day=>day>=cutoff&&day<=today).sort().at(-1);if(latest){count++;const version=typeof records[latest]==='string'?records[latest]:records[latest].version;versions[version]=(versions[version]||0)+1}}
  summary.active[name]=count;summary.versions[name]=versions;
 }
 for(const records of Object.values(state.reports||{}))for(const [day,record] of Object.entries(records)){const version=typeof record==='string'?record:record.version;summary.daily[day]??={};summary.daily[day][version]=(summary.daily[day][version]||0)+1}
 return summary;
}
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function usageDashboard(summary){return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fledge usage</title><style>body{font:16px system-ui;background:#101010;color:#eee9df;margin:0;padding:clamp(20px,5vw,64px);max-width:1000px}h1{font-size:42px;font-weight:500}main{display:grid;gap:24px}.counts{display:flex;gap:32px;flex-wrap:wrap}.counts strong{display:block;font-size:40px}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #333;padding:12px}p,small{color:#aaa}caption{text-align:left;font-size:22px;margin:20px 0}</style><h1>Fledge usage</h1><p>Consenting active installations | ${escape(summary.asOf)} UTC</p><main><div class="counts">${Object.entries(summary.active).map(([name,count])=>`<div><strong>${count}</strong>${name==='day'?'Today':name==='week'?'Last 7 days':'Last 30 days'}</div>`).join('')}</div><table><caption>Versions in the last 7 days</caption><thead><tr><th>Version</th><th>Installations</th></tr></thead><tbody>${Object.entries(summary.versions.week).sort(([a],[b])=>a.localeCompare(b)).map(([version,count])=>`<tr><td>${escape(version)}</td><td>${count}</td></tr>`).join('')||'<tr><td colspan="2">No reports yet</td></tr>'}</tbody></table><table><caption>Daily reports</caption><thead><tr><th>Day</th><th>Version</th><th>Installations</th></tr></thead><tbody>${Object.entries(summary.daily).sort(([a],[b])=>b.localeCompare(a)).flatMap(([day,versions])=>Object.entries(versions).map(([version,count])=>`<tr><td>${escape(day)}</td><td>${escape(version)}</td><td>${count}</td></tr>`)).join('')}</tbody></table></main><p>Self-reported, opt-in installation counts. One running panel with recent authenticated activity counts as one installation. This does not count individual people. Random identifiers and daily records expire after 30 days; artifact snapshots expire after one day (at most 31 days total record retention).</p></html>`;}
export async function collectUsage(){
 const repo=process.env.USAGE_INTAKE_REPOSITORY,token=process.env.USAGE_INTAKE_TOKEN||process.env.GH_TOKEN,key=process.env.USAGE_PRIVATE_KEY;
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo||'')||!token||!key)throw Error('Usage collector configuration is incomplete');
 const directory='.usage',path=directory+'/previous/state.json';let state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{schema:1,reports:{},withdrawn:{}};
 state=updateUsageState(state,{schema:1,kind:'withdraw',id:'0'.repeat(43),day:new Date().toISOString().slice(0,10)});delete state.withdrawn['0'.repeat(43)];
 const request=async(path,method='GET',body)=>{const response=await fetch('https://api.github.com/repos/'+repo+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),accept:'application/vnd.github+json','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('GitHub intake request failed');return response.json()};
 const processed=[];let rejected=0;let cursor=state.cursor||new Date(Date.now()-30*86400000).toISOString();const since=new Date(new Date(cursor).getTime()-1000).toISOString();
 for(let page=1;page<=10;page++){
  const issues=await request('/issues?state=all&sort=updated&direction=asc&since='+encodeURIComponent(since)+'&per_page=100&page='+page);
  for(const issue of issues){if(typeof issue.updated_at==='string'&&issue.updated_at>cursor)cursor=issue.updated_at;if(issue.pull_request||issue.title!=='Fledge encrypted usage report'||typeof issue.body!=='string'||!issue.body.startsWith('fledge-usage-v1\n'))continue;
   try{if(issue.body.length>4096)throw Error('Oversized envelope');const report=openUsageReport(JSON.parse(issue.body.slice(16)),key);state=updateUsageState(state,report,new Date(),issue.number);processed.push(issue.number)}catch{rejected++;}
  }
  if(issues.length<100)break;
 }
 state.cursor=cursor;mkdirSync(directory+'/out',{recursive:true});const summary=usageSummary(state);
 writeFileSync(directory+'/out/state.json',JSON.stringify(state));writeFileSync(directory+'/out/aggregate.json',JSON.stringify(summary,null,2));writeFileSync(directory+'/out/dashboard.html',usageDashboard(summary));
 // The workflow uploads durable private state before closing receipts. If upload
 // fails they remain open; the next collection deduplicates the same id/day.
 writeFileSync(directory+'/processed.json',JSON.stringify(processed));
 if(process.env.GITHUB_STEP_SUMMARY)writeFileSync(process.env.GITHUB_STEP_SUMMARY,`# Fledge usage\n\nToday: **${summary.active.day}** | 7 days: **${summary.active.week}** | 30 days: **${summary.active.month}**\n\nDownload the private usage-state artifact for the dashboard.\n\n${rejected} invalid encrypted receipts were ignored.\n`);
}
export async function closeReceipts(){const repo=process.env.USAGE_INTAKE_REPOSITORY,token=process.env.USAGE_INTAKE_TOKEN||process.env.GH_TOKEN;for(const id of JSON.parse(readFileSync('.usage/processed.json','utf8'))){if(!Number.isInteger(id)||id<1)throw Error('Invalid receipt');const response=await fetch('https://api.github.com/repos/'+repo+'/issues/'+id,{method:'PATCH',headers:{...(token?{authorization:'Bearer '+token}:{}),accept:'application/vnd.github+json','content-type':'application/json'},body:JSON.stringify({state:'closed'}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Could not close processed intake receipt')}}
if(process.argv[1]?.endsWith('usage-collector.mjs')){if(process.argv.includes('--close'))await closeReceipts();else await collectUsage()}
