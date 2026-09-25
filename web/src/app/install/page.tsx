'use client';
import Link from 'next/link';
import {ArrowDownRight,BookOpen,HardDrive,RefreshCw} from 'lucide-react';

const diagram=[
 '   F L E D G E     /     RUNNING',
 '   ┌───────────────────────────┐',
 '   │  PANEL  ───  API  ─── DB  │',
 '   └─────────────┬─────────────┘',
 '                 │ outbound',
 '          ┌──────┴──────┐',
 '          │  NODE  ···  │',
 '          └──────┬──────┘',
 '          ┌──────┴──────┐',
 '          │ GAME SERVER │',
 '          └─────────────┘',
].join('\n');

export default function InstallPage(){return <main className="install-page"><header className="install-header"><Link href="/" className="install-brand"><span className="brand-mark"><img src="/fledge-symbol.png" alt=""/></span><strong>Fledge</strong></Link><span className="eyebrow">SETUP / EXISTING PANEL</span></header><div className="install-layout"><section className="install-main"><div className="eyebrow">YOUR PANEL IS RUNNING</div><h1>One panel.<br/><span>More nodes.</span></h1><p className="install-lead">This page belongs to an installed Fledge panel. There is no second panel installer here. Add capacity from Nodes, update this panel from Updates, or use the repository guide when setting up a fresh host.</p><div className="install-actions"><Link className="btn primary" href="/nodes"><HardDrive size={16}/> Connect a node <ArrowDownRight size={16}/></Link><Link className="btn" href="/updates"><RefreshCw size={15}/> Update this panel</Link></div><div className="install-hint"><BookOpen size={17}/><p><strong>Installing Fledge for the first time?</strong><br/>Open the Quick start in the repository README. It has the host install commands, environment setup, and health checks before you sign into a panel.</p></div><a className="install-doc-link" href="https://github.com/kavaliersdelikt/fledge#quick-start" target="_blank" rel="noreferrer">Open the Fledge setup guide <span>↗</span></a></section><aside className="install-aside"><div className="install-aside-mark">F / CONNECTED FLEET</div><pre aria-label="Fledge panel and node connection diagram">{diagram}</pre><div className="install-aside-note"><span className="install-live"/>Nodes connect outbound to the panel.<small>Enroll each Linux Docker host from the Nodes page. Windows evaluation uses a WSL2 Linux distribution.</small></div></aside></div><footer className="install-footer">Panel installation happens once on the control host. Node enrollment, panel updates, and template setup live inside the running workspace.</footer></main>}
