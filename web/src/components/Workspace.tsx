"use client";

import { ArrowUpRight, ChevronRight, Command, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type User } from "@/lib/api";
import { AppSidebar, destinations } from "./app-sidebar";
import { Modal } from "./feedback";

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
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    setSidebarOpen(
      !document.cookie.split("; ").includes("sidebar_state=false"),
    );
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const links = destinations.filter(
    (d) =>
      (!d.adminOnly || user.role === "admin") &&
      d.title.toLowerCase().includes(search.toLowerCase()),
  );
  const title = pathname.startsWith("/servers/")
    ? "Server workspace"
    : destinations.find((d) => d.url === pathname)?.title || "Workspace";
  const openSearch = () => {
    setSearch("");
    setSearchOpen(true);
  };

  return (
    <TooltipProvider delay={250}>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        style={
          {
            "--sidebar-width": "16rem",
            "--sidebar-width-icon": "3.5rem",
          } as React.CSSProperties
        }
      >
        <a href="#workspace-content" className="skip-link">
          Skip to content
        </a>
        <AppSidebar user={user} onLogout={onLogout} onMore={openSearch} />
        <SidebarInset className="workspace-main">
          <header className="workspace-topbar">
            <SidebarTrigger />
            <span className="topbar-divider" />
            <nav aria-label="Breadcrumb" className="workspace-crumb">
              <Link href={user.role === "admin" ? "/" : "/servers"}>
                Workspace
              </Link>
              <ChevronRight size={13} />
              <span>{title}</span>
            </nav>
            <button className="quick-search" onClick={openSearch}>
              <Search size={15} />
              <span>Go to…</span>
              <kbd>Ctrl K</kbd>
            </button>
          </header>
          <div id="workspace-content" tabIndex={-1} className="content">
            {children}
          </div>
          <footer className="workspace-footer">
            <span>Fledge</span>
            <span>Self-hosted game servers</span>
          </footer>
        </SidebarInset>
        <Modal
          open={searchOpen}
          onOpenChange={setSearchOpen}
          title="Go to a page"
          description="Quick navigation across your workspace."
          compact
        >
          <div className="command-input">
            <Search size={18} />
            <input
              aria-label="Find a page"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pages…"
              autoFocus
            />
          </div>
          <div className="command-results">
            {links.length ? (
              links.map((d) => (
                <button
                  key={d.url}
                  onClick={() => {
                    setSearchOpen(false);
                    router.push(d.url);
                  }}
                >
                  <d.icon size={18} />
                  <span>
                    {d.title}
                    <small>{d.group}</small>
                  </span>
                  <ArrowUpRight size={16} />
                </button>
              ))
            ) : (
              <p className="empty">No matching pages.</p>
            )}
          </div>
          <p className="muted small">
            <Command size={12} /> Use Tab to select a page and Enter to open it.
          </p>
        </Modal>
      </SidebarProvider>
    </TooltipProvider>
  );
}
