"use client";
import { ApiError,json,request,type User } from "@/lib/api";
import { Notice } from "./shared";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { usePathname,useRouter,useSearchParams } from "next/navigation";
import { useEffect,useState } from "react";
import ActivityPage from "./ActivityPage";
import Auth from "./Auth";
import Customers from "./Customers";
import ServerDetail from "./Detail";
import Nodes from "./Nodes";
import Overview from "./Overview";
import Servers from "./Servers";
import SettingsPage from "./SettingsPage";
import Templates from "./Templates";
import UpdateCenter from "./UpdateCenter";
import Workspace from "./Workspace";
import { ConfirmationProvider } from "./feedback";

export default function Panel() {
  const router = useRouter(),
    pathname = usePathname(),
    query = useSearchParams();
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request<User>("/auth/me")
      .then((u) => {
        if (active) setUser(u);
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
  if (loading)
    return (
      <div className="center-loader">
        <RefreshCw className="spin" />
        Opening your workspace…
      </div>
    );
  if (error)
    return (
      <div className="center-loader">
        <div className="connection-error">
          <h1>Connection unavailable</h1>
          <Notice status="danger">{error}</Notice>
          <button className="btn primary" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  if (!user || (user.role === "admin" && !user.has2fa))
    return (
      <Auth
        existing={user || undefined}
        onSuccess={(u) => {
          setUser(u);
          router.push(u.role === "admin" ? "/" : "/servers");
        }}
      />
    );
  const admin = user.role === "admin",
    seg = pathname.split("/").filter(Boolean);
  const forbidden =
    ["nodes", "templates", "customers", "activity", "updates"].includes(
      seg[0],
    ) && !admin;
  let page;
  if (forbidden)
    page = (
      <div className="empty-page">
        <h1>Administrator access required</h1>
        <p className="muted">
          This section is available to workspace administrators.
        </p>
        <Link href="/servers" className="btn primary">
          Back to your servers
        </Link>
      </div>
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
  else if (seg.length > 1) page = null;
  else
    switch (seg[0]) {
      case undefined:
        page = admin ? <Overview /> : <Servers admin={false} />;
        break;
      case "servers":
        page = <Servers admin={admin} />;
        break;
      case "nodes":
        page = <Nodes />;
        break;
      case "templates":
        page = <Templates />;
        break;
      case "customers":
        page = <Customers />;
        break;
      case "activity":
        page = <ActivityPage />;
        break;
      case "updates":
        page = <UpdateCenter />;
        break;
      case "settings":
        page = <SettingsPage user={user} />;
        break;
    }
  return (
    <ConfirmationProvider>
      <Workspace
        user={user}
        onLogout={async () => {
          await json("POST", "/auth/logout");
          setUser(null);
          router.push("/");
        }}
      >
        {page || (
          <div className="empty-page">
            <span className="eyebrow">404 / Page unavailable</span>
            <h1>This page doesn’t exist.</h1>
            <p className="muted">
              Return to your servers to pick up where you left off.
            </p>
            <Link href="/servers" className="btn primary">
              View servers
            </Link>
          </div>
        )}
      </Workspace>
    </ConfirmationProvider>
  );
}
