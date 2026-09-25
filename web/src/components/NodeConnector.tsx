'use client';
import {useEffect,useMemo,useState} from 'react';
import {Check,Copy,HardDrive,LoaderCircle,RefreshCw,Terminal} from 'lucide-react';
import {API,json,request,type Node as NodeInfo} from '@/lib/api';

type Enrollment={nodeId:string;token:string;expiresInSeconds:number};
const defaultRepo=process.env.NEXT_PUBLIC_GITHUB_REPOSITORY||'kavaliersdelikt/navrylo';
function validRepo(value:string){return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)&&!value.includes('..');}
function shellQuote(value:string){return "'"+value.replace(/'/g,"'\\''")+"'";}
function psQuote(value:string){return "'"+value.replace(/'/g,"''")+"'";}
export default function NodeConnector(){
 const [nodes,setNodes]=useState<NodeInfo[]>([]),[nodeId,setNodeId]=useState(''),[repository,setRepository]=useState(defaultRepo),[platform,setPlatform]=useState<'linux'|'windows'>('linux'),[token,setToken]=useState<Enrollment|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false),[error,setError]=useState('');
 const apiUrl=API.replace(/\/+$/,'');
 async function loadNodes(){setLoading(true);setError('');try{const values=await request<NodeInfo[]>('/nodes');setNodes(values);if(!values.some(n=>n.id===nodeId))setNodeId(values[0]?.id||'')}catch(e){setError((e as Error).message)}finally{setLoading(false)}}
 useEffect(()=>{loadNodes();},[]);
 const command=useMemo(()=>{
  if(!token||!validRepo(repository)||!/^https?:\/\/[A-Za-z0-9.:/_-]+$/.test(apiUrl))return '';
  const raw=`https://raw.githubusercontent.com/${repository}/main/agent/`;
  if(platform==='linux')return `curl --proto '=https' --tlsv1.2 -fsSL ${shellQuote(raw+'connect.sh')} -o /tmp/navrylo-connect.sh && sudo sh /tmp/navrylo-connect.sh --api ${shellQuote(apiUrl)} --node ${shellQuote(token.nodeId)} --repo ${shellQuote(repository)}${apiUrl.startsWith('http://')?' --allow-insecure-http':''}`;
  return `$p=Join-Path $env:TEMP 'navrylo-connect.ps1'; Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(raw+'connect-wsl.ps1')} -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -ApiUrl ${psQuote(apiUrl)} -NodeId ${psQuote(token.nodeId)} -Repository ${psQuote(repository)}${apiUrl.startsWith('http://')?' -AllowInsecureHttp':''}; if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'WSL connector failed.' }; Remove-Item -LiteralPath $p -Force`;
 },[token,repository,apiUrl,platform]);
 async function issue(){if(!nodeId)return;const selected=nodes.find(n=>n.id===nodeId);if(selected?.status==='connected'&&!window.confirm('This rotates the node credential and briefly disconnects its current agent. Continue?'))return;setBusy(true);setError('');setCopied(false);try{const result=await json('POST',`/nodes/${nodeId}/enrollment`) as Enrollment;setToken(result);await loadNodes();}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function copy(){try{await navigator.clipboard.writeText(command);setCopied(true);setTimeout(()=>setCopied(false),1800)}catch{setError('Clipboard access was blocked. Select and copy the command manually.')}}
 return <section className="section node-connector"><div className="section-title"><div><div className="eyebrow">QUICK CONNECT / AGENT</div><h2>Connect a node</h2><p className="muted">Create a short-lived enrollment token and install the checksum-verified Linux agent with one command. A fresh token replaces the selected node’s existing credential.</p></div><button className="btn" onClick={loadNodes} disabled={loading}><RefreshCw size={15} className={loading?'spin':''}/> Refresh nodes</button></div>
  {loading?<div className="skeleton" aria-label="Loading nodes"/>:error&&!nodes.length?<div className="notice error" role="alert">{error}</div>:!nodes.length?<div className="notice">Register node capacity below first. You can return here to issue its one-time connection token.</div>:<>
   <div className="form-grid node-connect-options"><label className="field"><span>Node</span><select value={nodeId} onChange={e=>{setNodeId(e.target.value);setToken(null)}}>{nodes.map(n=><option key={n.id} value={n.id}>{n.name} · {n.location}</option>)}</select></label><label className="field"><span>GitHub repository (owner/name)</span><input value={repository} onChange={e=>{setRepository(e.target.value);setToken(null)}} placeholder="your-org/navrylo" autoComplete="off"/></label></div>
   <div className="form-actions"><button className="btn primary" onClick={issue} disabled={busy||!validRepo(repository)||!nodeId}>{busy?<LoaderCircle size={16} className="spin"/>:null}Generate one-time connector</button><span className="muted small">The latest published release must exist in this GitHub repository.</span></div>
   {token&&<div className="connector-result" role="status"><div className="notice token-notice"><strong>Enrollment token · expires in {Math.floor(token.expiresInSeconds/60)} minutes · shown once</strong><p>Copy this token now. The installer asks for it through a hidden terminal prompt; it is not included in the command.</p><code>{token.token}</code></div><div className="connector-tabs" role="tablist" aria-label="Node operating system"><button role="tab" aria-selected={platform==='linux'} className={platform==='linux'?'selected':''} onClick={()=>setPlatform('linux')}>Linux</button><button role="tab" aria-selected={platform==='windows'} className={platform==='windows'?'selected':''} onClick={()=>setPlatform('windows')}>Windows with WSL2</button></div><div className="connector-command"><Terminal size={16}/><code>{command||'Enter a valid owner/repository above to create the connector command.'}</code></div>{command&&<button className="btn" onClick={copy}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'Copied':'Copy one-line command'}</button>}{platform==='windows'&&<p className="muted small">Requires WSL2 Ubuntu and Docker Desktop WSL integration. The agent runs inside Linux; this does not install a native Windows service.</p>}<button className="text-button" onClick={()=>setToken(null)}>Hide token</button></div>}
  </>}
 </section>;
}
