"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Box,
  ChevronsUpDown,
  CornerDownLeft,
  Download,
  HardDrive,
  LayoutGrid,
  LogOut,
  Menu,
  Search,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { items, request, type Node, type Server as ServerInfo, type User } from "@/lib/api";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { TipProvider } from "./charts";
import { useGlide } from "./motion";
import { Status, btn } from "./shared";

type Destination = {
  title: string;
  url: string;
  icon: LucideIcon;
  group: "" | "Infrastructure" | "Administration";
  adminOnly: boolean;
};

export const destinations: Destination[] = [
  { title: "Overview", url: "/", icon: LayoutGrid, group: "", adminOnly: true },
  { title: "Servers", url: "/servers", icon: Server, group: "", adminOnly: false },
  { title: "Nodes", url: "/nodes", icon: HardDrive, group: "Infrastructure", adminOnly: true },
  { title: "Templates", url: "/templates", icon: Box, group: "Infrastructure", adminOnly: true },
  { title: "Customers", url: "/customers", icon: Users, group: "Administration", adminOnly: true },
  { title: "Activity", url: "/activity", icon: Activity, group: "Administration", adminOnly: true },
  { title: "Updates", url: "/updates", icon: Download, group: "Administration", adminOnly: true },
  { title: "Settings", url: "/settings", icon: Settings, group: "Administration", adminOnly: false },
];

function isActive(pathname: string, url: string) {
  return url === "/" ? pathname === "/" : pathname === url || pathname.startsWith(`${url}/`);
}

type Attention = { servers: number; nodes: number };

/** Counts that deserve a badge in the sidebar: only things that are wrong. */
function useAttention(admin: boolean) {
  const [attention, setAttention] = useState<Attention>({ servers: 0, nodes: 0 });
  useEffect(() => {
    if (!admin) return;
    let live = true;
    const load = () =>
      request<{ servers: Record<string, number>; capacity: Node[] }>("/overview")
        .then((o) => {
          if (!live) return;
          const s = o.servers;
          setAttention({
            servers: (s.failed || 0) + (s.unreachable || 0) + (s.missing || 0),
            nodes: o.capacity.filter((n) => n.status !== "connected").length,
          });
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [admin]);
  return attention;
}

export default function Workspace({
  user,
  onLogout,
  children,
}: {
  user: User;
  onLogout: () => Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const admin = user.role === "admin";
  const attention = useAttention(admin);
  // Customers only see two pages, so they get one unlabeled group.
  const allowed = useMemo(
    () => destinations.filter((d) => !d.adminOnly || admin).map((d) => (admin ? d : { ...d, group: "" as const })),
    [admin],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => setNavOpen(false), [pathname]);

  const sidebar = (
    <SidebarContent
      user={user}
      destinations={allowed}
      pathname={pathname}
      attention={attention}
      onLogout={onLogout}
      onSearch={() => {
        setNavOpen(false);
        setPaletteOpen(true);
      }}
    />
  );

  return (
    <TipProvider delay={120}>
      <div className="app">
        <a href="#content" className="skip-link">
          Skip to content
        </a>
        <aside className="sidebar" aria-label="Main navigation">
          {sidebar}
        </aside>
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="sidebar sidebar--sheet" showCloseButton={false}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>
        <div className="main">
          <header className="mobilebar">
            <button className={btn("ghost", "icon")} aria-label="Open navigation" onClick={() => setNavOpen(true)}>
              <Menu />
            </button>
            <Link href={admin ? "/" : "/servers"} className="brand">
              <img src="/fledge-symbol.png" alt="" />
              Fledge
            </Link>
            <button className={btn("ghost", "icon")} aria-label="Search" onClick={() => setPaletteOpen(true)}>
              <Search />
            </button>
          </header>
          <main id="content" tabIndex={-1} className="page" key={pathname}>
            {children}
          </main>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} destinations={allowed} />
      </div>
    </TipProvider>
  );
}

function SidebarContent({
  user,
  destinations: allowed,
  pathname,
  attention,
  onLogout,
  onSearch,
}: {
  user: User;
  destinations: Destination[];
  pathname: string;
  attention: Attention;
  onLogout: () => Promise<void>;
  onSearch: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  const [nav, setNav] = useState<HTMLElement | null>(null);
  useGlide(nav, '[aria-current="page"]', pathname);
  const groups = [...new Set(allowed.map((d) => d.group))];
  const badge = (url: string) =>
    url === "/servers" && attention.servers ? (
      <span className="nav__badge nav__badge--bad" title={`${attention.servers} need attention`}>
        {attention.servers}
        <span className="sr-only"> need attention</span>
      </span>
    ) : url === "/nodes" && attention.nodes ? (
      <span className="nav__badge" title={`${attention.nodes} offline`}>
        {attention.nodes}
        <span className="sr-only"> offline</span>
      </span>
    ) : null;
  return (
    <>
      <Link href={user.role === "admin" ? "/" : "/servers"} className="brand">
        <img src="/fledge-symbol.png" alt="" />
        <span>Fledge</span>
      </Link>
      <button className="sidebar-search" onClick={onSearch}>
        <Search />
        <span>Search</span>
        <kbd>Ctrl K</kbd>
      </button>
      <nav className="nav glide" ref={setNav}>
        {groups.map((group) => (
          <div className="nav__group" key={group || "main"}>
            {allowed
              .filter((d) => d.group === group)
              .map((d) => (
                <Link
                  key={d.url}
                  href={d.url}
                  className="nav__item"
                  aria-current={isActive(pathname, d.url) ? "page" : undefined}
                >
                  <d.icon />
                  {d.title}
                  {badge(d.url)}
                </Link>
              ))}
          </div>
        ))}
      </nav>
      <div className="sidebar__foot">
        <DropdownMenu>
          <DropdownMenuTrigger className="account">
            <span className="avatar" aria-hidden="true">
              {user.email[0].toUpperCase()}
            </span>
            <span className="account__text">
              <strong>{user.email}</strong>
              <small>{user.role === "admin" ? "Administrator" : "Customer"}</small>
            </span>
            <ChevronsUpDown className="account__chevron" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={6} className="menu">
            <DropdownMenuItem render={<Link href="/settings" />}>
              <Settings /> Account settings
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/install" />}>
              <BookOpen /> Getting started
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={leaving}
              onClick={async () => {
                setLeaving(true);
                setError("");
                try {
                  await onLogout();
                } catch (e) {
                  setError((e as Error).message);
                  setLeaving(false);
                }
              }}
            >
              <LogOut /> {leaving ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {error ? (
          <p role="alert" className="inline-error">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

type Result =
  | { kind: "page"; key: string; title: string; hint: string; url: string; icon: LucideIcon }
  | { kind: "server"; key: string; title: string; hint: string; url: string; status: string };

function CommandPalette({
  open,
  onOpenChange,
  destinations: allowed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destinations: Destination[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [list, setList] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    let live = true;
    request<ServerInfo[]>("/servers?limit=100&offset=0")
      .then((xs) => live && setServers(items(xs)))
      .catch(() => live && setServers([]));
    return () => {
      live = false;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const results: Result[] = [
    ...allowed
      .filter((d) => d.title.toLowerCase().includes(q))
      .map((d) => ({ kind: "page" as const, key: d.url, title: d.title, hint: "", url: d.url, icon: d.icon })),
    ...servers
      .filter((s) => !q || `${s.name} ${s.nodeName || ""} ${s.templateId}`.toLowerCase().includes(q))
      .slice(0, q ? 12 : 6)
      .map((s) => ({
        kind: "server" as const,
        key: s.id,
        title: s.name,
        hint: [s.nodeName, s.templateId].filter(Boolean).join(" · "),
        url: `/servers/${s.id}`,
        status: s.status,
      })),
  ];
  const index = Math.min(active, Math.max(0, results.length - 1));
  useGlide(list, '[aria-selected="true"]', `${index}:${results.length}:${open}`);
  useEffect(() => {
    list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, list]);
  const go = (url: string) => {
    onOpenChange(false);
    router.push(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="palette" showCloseButton={false}>
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="palette__input">
          <Search />
          <input
            aria-label="Search pages and servers"
            placeholder="Search pages and servers…"
            value={query}
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[index] ? `palette-${index}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => (results.length ? (i + 1) % results.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
              } else if (e.key === "Enter" && results[index]) {
                e.preventDefault();
                go(results[index].url);
              }
            }}
          />
        </div>
        <div className="palette__results glide" id="palette-results" role="listbox" ref={setList}>
          {results.length ? (
            results.map((r, i) => (
              <Fragment key={r.key}>
                {i === 0 || results[i - 1].kind !== r.kind ? (
                  <div className="palette__group" role="presentation">
                    {r.kind === "page" ? "Pages" : "Servers"}
                  </div>
                ) : null}
                <button
                  id={`palette-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === index}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(r.url)}
                >
                  {r.kind === "page" ? <r.icon /> : <Server />}
                  <span className="palette__title">{r.title}</span>
                  <span className="palette__hint">{r.hint}</span>
                  {r.kind === "server" ? <Status value={r.status} /> : null}
                  {i === index ? <CornerDownLeft className="palette__enter" /> : null}
                </button>
              </Fragment>
            ))
          ) : (
            <p className="palette__empty">Nothing matches “{query}”.</p>
          )}
        </div>
        <div className="palette__foot" aria-hidden="true">
          <span>
            <kbd>
              <ArrowUp size={10} />
              <ArrowDown size={10} />
            </kbd>
            Move
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>
            Open
          </span>
          <span>
            <kbd>Esc</kbd>
            Close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
