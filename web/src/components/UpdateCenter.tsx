"use client";
import {request} from "@/lib/api";
import {Check, ExternalLink, RefreshCw, ShieldCheck, Sparkles} from "lucide-react";
import {useCallback, useEffect, useRef, useState} from "react";
import {Notice} from "./shared";

type UpdateInfo={repository:string;currentVersion:string;latestVersion:string|null;updateAvailable:boolean;releaseName:string|null;releaseUrl:string;body:string;publishedAt:string|null;checkedAt:string;error:string|null;oneClickEnabled:boolean};
type UpdateStatus={state:"idle"|"running"|"succeeded"|"failed"|"unavailable";phase:string;version?:string|null;logs:string[];startedAt?:string|null;finishedAt?:string|null;error?:string|null};

const steps=["preparing","backup","installing","checking-health"];
const phaseCopy:Record<string,string>={starting:"Preparing the update",preparing:"Checking this installation",backup:"Saving a database backup", "backup-complete":"Database backup saved",installing:"Installing the release", "checking-health":"Checking panel health",complete:"Update complete",failed:"Update stopped",unavailable:"Updater unavailable",restarting:"Waiting for the panel to reconnect"};

export default function UpdateCenter(){
 const [info,setInfo]=useState<UpdateInfo|null>(null);
 const [status,setStatus]=useState<UpdateStatus|null>(null);
 const [loading,setLoading]=useState(true);
 const [checking,setChecking]=useState(false);
 const [starting,setStarting]=useState(false);
 const [error,setError]=useState("");
 const initiated=useRef(false);

 const load=useCallback(async(force=false)=>{
  setChecking(true);setError("");
  try{setInfo(await request<UpdateInfo>(`/updates${force?"?refresh=1":""}`));}
  catch(e){setError((e as Error).message);}
  finally{setChecking(false);setLoading(false);}
 },[]);

 const refreshStatus=useCallback(async()=>{
  try{
   const next=await request<UpdateStatus>("/updates/status");
   setStatus(next);
   if(initiated.current&&next.state==="succeeded"){initiated.current=false;void load(true);}
   if(next.state==="succeeded"||next.state==="failed")initiated.current=false;
  }catch{
   if(initiated.current)setStatus(current=>current?{...current,phase:"restarting"}:current);
  }
 },[load]);

 useEffect(()=>{void Promise.all([load(),refreshStatus()]);},[load,refreshStatus]);
 useEffect(()=>{
  if(status?.state!=="running"&&!initiated.current)return;
  const timer=window.setInterval(()=>void refreshStatus(),1800);
  return()=>window.clearInterval(timer);
 },[status?.state,refreshStatus]);

 async function startUpdate(){
  setStarting(true);setError("");
  try{
   const next=await request<UpdateStatus>("/updates/run",{method:"POST",body:"{}"});
   initiated.current=next.state==="running";
   setStatus(next);
  }catch(e){setError((e as Error).message);}
  finally{setStarting(false);}
 }

 const running=status?.state==="running";
 const progressPhase=status?.phase==="backup-complete"?"installing":status?.phase||"";
 const progressStep=steps.indexOf(progressPhase);
 const percent=running?({starting:6,preparing:12,backup:34,"backup-complete":45,installing:62,"checking-health":84,complete:100,restarting:84} as Record<string,number>)[status?.phase||""]||8:status?.state==="succeeded"?100:0;

 return <>
  <div className="heading">
   <div><div className="eyebrow">Workspace / Updates</div><h1>Updates</h1><p className="muted">Keep the panel current while its data and settings stay in place.</p></div>
   <button className="btn" onClick={()=>void load(true)} disabled={loading||checking||running}><RefreshCw size={15} className={checking?"spin":""}/> Check for updates</button>
  </div>

  <section className="update-status">
   <div className="update-mark" aria-hidden="true"><RefreshCw size={17} className={running?"spin":""}/></div>
   <div className="update-summary"><span className="eyebrow">Installed version</span><strong>{info?`v${info.currentVersion}`:loading?"Checking…":"Unavailable"}</strong><p>{running?phaseCopy[status?.phase||""]||"Updating the panel":info?.updateAvailable?"A newer stable release is ready to install.":info?.latestVersion?`You’re up to date with v${info.latestVersion}.`:"Release information is unavailable."}</p></div>
   <div className="update-divider"/>
   <div className="update-latest"><span className="muted small">Latest release</span><strong>{info?.latestVersion?`v${info.latestVersion}`:"—"}</strong>{info?.publishedAt&&<span className="muted small">Published {new Date(info.publishedAt).toLocaleDateString()}</span>}</div>
  </section>

  {error&&<Notice status="danger" title="Update action failed">{error}</Notice>}
  {info?.error&&<Notice status="warning" title="Could not check for a release">{info.error}</Notice>}

  <section className={`section updater-action ${running?"is-running":""}`}>
   <div className="section-title"><div><span className="eyebrow">Panel maintenance</span><h2>{running?"Update in progress":status?.state==="succeeded"?"Panel updated":status?.state==="failed"?"Update needs attention":"Install the latest release"}</h2><p className="muted">{running?"Keep this page open to follow each step. The panel may briefly reconnect while its services restart.":"One click backs up PostgreSQL, installs the release, and checks the panel before reporting success."}</p></div>
    {info?.updateAvailable&&info.oneClickEnabled&&status?.state!=="running"&&<button className="btn primary" onClick={()=>void startUpdate()} disabled={starting||loading}><Sparkles size={15}/>{starting?"Starting…":"Update panel"}</button>}
   </div>

   {info?.updateAvailable&&!info.oneClickEnabled&&<Notice status="warning" title="One-click updates are not enabled">This installation needs the updater service added to its Docker Compose configuration before updates can run here.</Notice>}
   {info?.latestVersion&&!info.updateAvailable&&status?.state!=="running"&&<Notice status="success" title="This panel is up to date">You’re running the latest published release.</Notice>}

   {running&&<div className="update-progress" role="status" aria-live="polite">
    <div className="update-progress-heading"><span><span className="update-live-dot"/>{phaseCopy[status?.phase||""]||"Updating the panel"}</span><span>{progressStep>=0?`Step ${progressStep+1} of 4`:"Starting"}</span></div>
    <div className="update-progress-track"><span style={{width:`${percent}%`}}/></div>
    <ol className="update-steps">{[["preparing","Preparing"],["backup","Database backup"],["installing","Installing"],["checking-health","Health check"]].map(([key,label],index)=>{const done=progressStep>index||status?.phase==="backup-complete"&&index===1;const current=progressPhase===key;return <li key={key} className={`${done?"done":""} ${current?"current":""}`}><span>{done?<Check size={12}/>:index+1}</span>{label}</li>;})}</ol>
   </div>}

   {status?.state==="succeeded"&&<Notice status="success" title={`Fledge v${status.version||info?.latestVersion||""} is ready`}>The database backup was retained, and the panel passed its health checks.</Notice>}
   {status?.state==="failed"&&<Notice status="danger" title="The update did not finish">{status.error||"Review the updater log below. The previous application revision was restored when possible."}</Notice>}
   {status?.phase==="restarting"&&<Notice status="accent" title="Waiting for the panel to reconnect">The update is still running on the host. This page will resume its progress when the API is back.</Notice>}

   {(running||status?.state==="failed"||status?.state==="succeeded")&&!!status.logs?.length&&<details className="update-log"><summary>Update activity <span>{status.logs.length} lines</span></summary><pre>{status.logs.join("\n")}</pre></details>}
  </section>

  {info&&<Notice status={info.updateAvailable?"warning":"default"} className="update-release-notice" title={info.updateAvailable?"Release notes":"Update safety"}>
   {info.updateAvailable&&info.releaseUrl?<a href={info.releaseUrl} target="_blank" rel="noreferrer" className="notice-link">Read release notes <ExternalLink size={13}/></a>:<span className="update-safety"><ShieldCheck size={15}/> Updates keep the PostgreSQL volume and your `.env` settings. A database backup is created before the panel is rebuilt.</span>}
  </Notice>}

  {info?.latestVersion&&info.body&&<section className="section"><div className="section-title"><div><h2>{info.releaseName}</h2><p className="muted">Release notes from GitHub.</p></div><a className="btn" href={info.releaseUrl} target="_blank" rel="noreferrer">View release <ExternalLink size={14}/></a></div><pre className="release-notes">{info.body}</pre></section>}
  {info&&<p className="muted small update-meta">Repository: <a href={`https://github.com/${info.repository}`} target="_blank" rel="noreferrer">{info.repository}</a> · Checked {new Date(info.checkedAt).toLocaleString()}</p>}
 </>;
}
