"use client";

import { ArrowUpRight, Command, Search } from "lucide-react";
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

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
  const [activeResult, setActiveResult] = useState(0);
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
    setActiveResult(0);
    setSearchOpen(true);
  };
  const openDestination = (url: string) => {
    setSearchOpen(false);
    router.push(url);
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
            <Breadcrumb className="workspace-crumb">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link href={user.role === "admin" ? "/" : "/servers"} />}>Workspace</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem><BreadcrumbPage>{title}</BreadcrumbPage></BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
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
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveResult((current) => links.length ? (current + 1) % links.length : 0);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveResult((current) => links.length ? (current - 1 + links.length) % links.length : 0);
                } else if (e.key === "Enter" && links[activeResult]) {
                  e.preventDefault();
                  openDestination(links[activeResult].url);
                }
              }}
              placeholder="Search pages…"
              role="combobox"
              aria-expanded="true"
              aria-controls="workspace-command-results"
              aria-activedescendant={links[activeResult] ? `workspace-command-${activeResult}` : undefined}
              autoFocus
            />
          </div>
          <div className="command-results" id="workspace-command-results" role="listbox" aria-label="Workspace destinations">
            {links.length ? (
              links.map((d, index) => (
                <button
                  key={d.url}
                  id={`workspace-command-${index}`}
                  role="option"
                  aria-selected={index === activeResult}
                  onMouseEnter={() => setActiveResult(index)}
                  onClick={() => openDestination(d.url)}
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
