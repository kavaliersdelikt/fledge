'use client';
import {useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {Check,Copy,Download,ExternalLink,Monitor,Terminal} from 'lucide-react';

type Platform='linux'|'macos'|'windows';
const diagram=["  .-------------------.","  | NAVRYLO / LOCAL  |","  |   .-----------.   |","  |   | API  ·    |   |","  |   | DB   ···  |   |","  |   | WEB  ···· |   |","  |   +-----------+   |","  +--------+----------+","           |","     .-----+------.","     | NODE / xN  |","     +------------+"].join('\n');
const configuredRepo=process.env.NEXT_PUBLIC_GITHUB_REPOSITORY||'kavaliersdelikt/navrylo';
const slugPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const refPattern=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
function sh(value:string){return "'"+value.replace(/'/g,"'\\''")+"'";}
function ps(value:string){return "'"+value.replace(/'/g,"''")+"'";}

export default function InstallPage(){
 const [repository,setRepository]=useState(configuredRepo),[ref,setRef]=useState('main'),[platform,setPlatform]=useState<Platform>('windows'),[copied,setCopied]=useState(false);
 useEffect(()=>{const agent=navigator.userAgent.toLowerCase();setPlatform(/windows|win32/.test(agent)?'windows':/macintosh|mac os|iphone|ipad/.test(agent)?'macos':'linux')},[]);
 const valid=slugPattern.test(repository)&&!repository.includes('..')&&refPattern.test(ref)&&!ref.includes('..');
 const command=useMemo(()=>{
  if(!valid)return '';
  const url=`https://github.com/${repository}.git`;
  if(platform==='windows')return `git clone --depth 1 --branch ${ps(ref)} ${ps(url)} navrylo; if ($LASTEXITCODE -ne 0) { throw 'Download failed.' }; Set-Location navrylo; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1`;
  return `git clone --depth 1 --branch ${sh(ref)} ${sh(url)} navrylo && cd navrylo && sh ./install.sh`;
 },[repository,ref,platform,valid]);
 async function copy(){try{await navigator.clipboard.writeText(command);setCopied(true);setTimeout(()=>setCopied(false),1700)}catch{setCopied(false)}}
 const choices:[Platform,string,string][]=[['windows','Windows','PowerShell'],['macos','macOS','Terminal'],['linux','Linux','Terminal']];
 return <main className="install-page"><header className="install-header"><Link href="/" className="install-brand"><span className="brand-mark">N</span><strong>navrylo</strong></Link><span className="eyebrow">INSTALL ASSISTANT / SOURCE RELEASE</span></header><div className="install-layout"><section className="install-main"><div className="eyebrow">GET STARTED</div><h1>Set up your<br/><span>server workspace.</span></h1><p className="install-lead">Choose a platform and get one command to download Navrylo, prepare its local secrets, start the panel, and wait for health checks.</p><label className="field"><span>GitHub repository</span><input value={repository} onChange={e=>setRepository(e.target.value.trim())} placeholder="organization/navrylo" autoComplete="off" spellCheck={false}/></label><label className="field"><span>Branch or release tag</span><input value={ref} onChange={e=>setRef(e.target.value.trim())} placeholder="main" autoComplete="off" spellCheck={false}/></label><div className="install-platforms" role="tablist" aria-label="Choose your operating system">{choices.map(([id,label,shell])=><button key={id} role="tab" aria-selected={platform===id} className={platform===id?'selected':''} onClick={()=>setPlatform(id)}><Monitor size={16}/><span>{label}<small>{shell}</small></span></button>)}</div>{command?<div className="install-command"><div className="command-label"><Terminal size={15}/> ONE-LINE INSTALL <span>{platform==='windows'?'PowerShell':'shell'}</span></div><pre><code>{command}</code></pre><button className="btn primary" onClick={copy}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?'Copied':'Copy command'}</button></div>:<div className="notice">Enter your published GitHub owner/repository and branch or release tag to generate a command.</div>}<div className="install-hint"><Download size={16}/><p>The installer preserves an existing <code>.env</code>. For a new checkout, it creates random secrets with private file permissions, starts Docker Compose, then checks the API and panel health endpoints.</p></div><p className="install-back"><Link href="/">Return to panel <ExternalLink size={14}/></Link></p></section><aside className="install-aside"><div className="install-aside-mark">N / 01</div><pre aria-label="Abstract server diagram">{diagram}</pre><div className="install-aside-note"><span className="install-live"/>Installed services are bound to this machine’s loopback address by default.<small>For deployment on a public host, configure HTTPS, backups, firewall rules, and external storage before exposing access.</small></div></aside></div><footer className="install-footer">Private GitHub repositories require your GitHub sign-in. Publish the repository before distributing unauthenticated node-connector downloads. Windows uses Docker Desktop in Linux-container mode.</footer></main>;
}
