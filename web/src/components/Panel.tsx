"use client";
import Virtualization from "./Virtualization";
import { ApiError, json, request, type User } from "@/lib/api";
import { FeaturesContext, noFeatures, type Features } from "@/lib/commerce";
import { MarkImage, useBrand } from "@/lib/brand";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import KnowledgeEditor,{PublicHelp} from './KnowledgeEditor';
import StepUpPrompt from './StepUpPrompt';
import SuspendedShell from './SuspendedShell';
import Team from './Team';
import Support,{NewTicket,Article} from './Support';
import {SupportSettings,SupportReports,AbuseForm} from './SupportSettings';
import ActivityPage from "./ActivityPage";
import ApiDocs from "./ApiDocs";
import AppearancePage from "./AppearancePage";
import Auth from "./Auth";
import Billing from "./Billing";
import BillingAdmin from "./BillingAdmin";
import Store, { OrderReturn } from "./Store";
import Customers from "./Customers";
import ServerDetail from "./Detail";
import Nodes from "./Nodes";
import Plugins from "./Plugins";
import Overview from "./Overview";
import Servers from "./Servers";
import SettingsPage from "./SettingsPage";
import Templates from "./Templates";
import Resilience from "./Resilience";
import UpdateCenter from "./UpdateCenter";
import Workspace from "./Workspace";
import { ConfirmationProvider } from "./feedback";
import { ToastProvider } from "./toast";
import { Button, Empty, Notice, btn } from "./shared";

export default function Panel() {
  const router = useRouter(),
    pathname = usePathname(),
    query = useSearchParams();
  const { brand, setMode } = useBrand();
  const [user, setUser] = useState<User | null>(null),
    [features, setFeatures] = useState<Features>(noFeatures),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request<User>("/auth/me")
      .then((u) => {
        if (active) setUser(u);
        // A choice made on another device follows the account.
        if (active && u.preferences?.mode && brand.theme.allowUserMode) setMode(u.preferences.mode);
      })
      .catch((e) => {
        if (active && (!(e instanceof ApiError) || e.status !== 401))
          setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  // What the panel offers this person (store, billing, self-service) is loaded once they are signed in.
  const uid = user?.id;
  useEffect(() => {
    if (!uid) return;
    let live = true;
    const load = () =>
      request<Features>("/features")
        .then((f) => {if(live){setFeatures(f);setUser(u=>u?{...u,status:f.account.status,isSuper:f.isSuper,permissions:f.permissions}:u);}})
        .catch(() => {});
    void load();
    // Buttons follow the administrator's settings: look again when the tab is shown and every few minutes.
    const onShow = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onShow);
    const timer = window.setInterval(onShow, 60 * 1000);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onShow);
      window.clearInterval(timer);
    };
  }, [uid]);
  if(pathname==='/help')return <ToastProvider><PublicHelp/></ToastProvider>;
  if(pathname==='/abuse')return <ToastProvider><ConfirmationProvider><StepUpPrompt/><AbuseForm/></ConfirmationProvider></ToastProvider>;
  if (loading)
    return (
      <div className="splash" role="status" aria-label="Loading">
        <MarkImage />
      </div>
    );
  if (error)
    return (
      <div className="splash">
        <div className="splash__box">
          <MarkImage />
          <h1>Can’t reach the panel API</h1>
          <Notice tone="bad">{error}</Notice>
          <Button variant="primary" onClick={() => location.reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  // An invitation or reset link (?token=) always shows the password form, even if someone is signed in.
  const linkToken = !!query.get("token");
  if (!user || linkToken || (user.role === "admin" && !user.has2fa))
    return (
      <Auth
        existing={linkToken ? undefined : user || undefined}
        onSuccess={(u) => {
          setUser(u);
          router.push(u.role === "admin" ? "/" : "/servers");
        }}
      />
    );
  if(features.account.status==='suspended'||user.status==='suspended')return <FeaturesContext.Provider value={features}><ToastProvider><ConfirmationProvider><StepUpPrompt/><SuspendedShell user={user} onLogout={async()=>{await json('POST','/auth/logout');setUser(null);router.push('/');}}/></ConfirmationProvider></ToastProvider></FeaturesContext.Provider>;
  const admin = user.role === "admin",
    seg = pathname.split("/").filter(Boolean);
  const requiredGrant=({virtualization:'nodes.view',nodes:'nodes.view',templates:'templates.manage',plugins:'plugins.manage',customers:'customers.view',activity:'audit.view',updates:'settings.view',resilience:'failover.manage','api-docs':'audit.view',support:seg[1]==='settings'?'support.manage':seg[1]==='reports'?'support.reports':seg[1]==='knowledge'?'support.articles':'support.view',team:'team.manage'} as Record<string,string>)[seg[0]];
  const forbidden = admin&&requiredGrant&&!(user.isSuper||user.permissions?.includes(requiredGrant)) ||
    ["virtualization", "nodes", "templates", "plugins", "customers", "activity", "updates", "resilience", "api-docs"].includes(seg[0]) && !admin;
  let page;
  if (forbidden)
    page = (
      <Empty
        title="Administrator access required"
        action={
          <Link href="/servers" className={btn("primary")}>
            Back to your servers
          </Link>
        }
      >
        This section is only available to panel administrators.
      </Empty>
    );
  else if (seg[0] === "servers" && seg[1] && seg.length === 2)
    page = (
      <ServerDetail
        key={seg[1]}
        id={seg[1]}
        admin={admin}
        actorId={user.id}
        tab={query.get("tab") || "console"}
      />
    );
  else if (seg[0] === "settings" && seg[1] === "appearance" && seg.length === 2)
    page = admin ? (
      <AppearancePage />
    ) : (
      <Empty title="Administrator access required">Only panel administrators can change the appearance.</Empty>
    );
  else if(seg[0]==='team')page=<Team user={user}/>;
  else if(seg[0]==='support'&&seg[1]==='knowledge')page=<KnowledgeEditor/>;
  else if(seg[0]==='support'&&seg[1]==='new')page=<NewTicket/>;
  else if(seg[0]==='support'&&seg[1]==='settings')page=<SupportSettings/>;
  else if(seg[0]==='support'&&seg[1]==='reports')page=<SupportReports/>;
  else if(seg[0]==='support'&&seg[1]==='articles'&&seg[2])page=<Article slug={seg[2]}/>;
  else if(seg[0]==='support')page=<Support user={user} id={seg[1]}/>;
  else if (seg.length > 1) page = null;
  else
    switch (seg[0]) {
      case undefined:
        // Coming back from the payment page lands here with ?order=.
        page = query.get("order") ? <OrderReturn id={query.get("order") as string} /> : query.get("store") ? <Store /> : admin ? <Overview /> : <Servers admin={false} />;
        break;
      case "servers":
        page = <Servers admin={admin} />;
        break;
      case "virtualization":
        page = <Virtualization />;
        break;
      case "nodes":
        page = <Nodes />;
        break;
      case "templates":
        page = <Templates />;
        break;
      case "plugins":
        page = <Plugins />;
        break;
      case "customers":
        page = <Customers />;
        break;
      case "activity":
        page = <ActivityPage />;
        break;
      case "api-docs":
        page = <ApiDocs />;
        break;
      case "resilience":
        page = <Resilience />;
        break;
      case "updates":
        page = <UpdateCenter isSuper={user.isSuper} />;
        break;
      case "settings":
        page = <SettingsPage user={user} />;
        break;
      case "store":
        page = <Store />;
        break;
      case "billing":
        page = admin ? <BillingAdmin /> : <Billing />;
        break;
    }
  return (
    <FeaturesContext.Provider value={features}>
    <ToastProvider>
    <ConfirmationProvider><StepUpPrompt/>
      <Workspace
        user={user}
        onLogout={async () => {
          await json("POST", "/auth/logout");
          setUser(null);
          router.push("/");
        }}
      >
        {page || (
          <Empty
            title="Page not found"
            action={
              <Link href={admin ? "/" : "/servers"} className={btn("primary")}>
                Go back
              </Link>
            }
          >
            There’s nothing at {pathname}.
          </Empty>
        )}
      </Workspace>
    </ConfirmationProvider>
    </ToastProvider>
    </FeaturesContext.Provider>
  );
}
