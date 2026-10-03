"use client";
import { ApiError, json, request, type User } from "@/lib/api";
import { MarkImage, useBrand } from "@/lib/brand";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import ActivityPage from "./ActivityPage";
import ApiDocs from "./ApiDocs";
import AppearancePage from "./AppearancePage";
import Auth from "./Auth";
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
  const admin = user.role === "admin",
    seg = pathname.split("/").filter(Boolean);
  const forbidden =
    ["nodes", "templates", "plugins", "customers", "activity", "updates", "resilience", "api-docs"].includes(seg[0]) && !admin;
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
        page = <UpdateCenter />;
        break;
      case "settings":
        page = <SettingsPage user={user} />;
        break;
    }
  return (
    <ToastProvider>
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
  );
}
