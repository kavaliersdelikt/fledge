"use client";

import {
  Activity,
  Box,
  Download,
  HardDrive,
  LayoutDashboard,
  Server,
  Settings,
  Users,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { type User } from "@/lib/api";
import { NavMain } from "@/components/nav-main";
import { NavProjects } from "@/components/nav-projects";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";

export const destinations = [
  {
    title: "Overview",
    url: "/",
    icon: LayoutDashboard,
    group: "Workspace",
    adminOnly: true,
  },
  {
    title: "Servers",
    url: "/servers",
    icon: Server,
    group: "Workspace",
    adminOnly: false,
  },
  {
    title: "Activity",
    url: "/activity",
    icon: Activity,
    group: "Workspace",
    adminOnly: true,
  },
  {
    title: "Nodes",
    url: "/nodes",
    icon: HardDrive,
    group: "Infrastructure",
    adminOnly: true,
  },
  {
    title: "Templates",
    url: "/templates",
    icon: Box,
    group: "Infrastructure",
    adminOnly: true,
  },
  {
    title: "Customers",
    url: "/customers",
    icon: Users,
    group: "Administration",
    adminOnly: true,
  },
  {
    title: "Updates",
    url: "/updates",
    icon: Download,
    group: "Administration",
    adminOnly: true,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
    group: "Administration",
    adminOnly: false,
  },
];

const groupIcons = {
  Workspace: LayoutDashboard,
  Infrastructure: HardDrive,
  Administration: Settings,
};

export function AppSidebar({
  user,
  onLogout,
  onMore,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: User;
  onLogout: () => Promise<void>;
  onMore: () => void;
}) {
  const pathname = usePathname();
  const roleDestinations = useMemo(
    () =>
      destinations.filter((item) => !item.adminOnly || user.role === "admin"),
    [user.role],
  );
  const navMain = useMemo(() => {
    const groups = [...new Set(roleDestinations.map((item) => item.group))];
    return groups.map((group) => {
      const children = roleDestinations.filter((item) => item.group === group);
      return {
        title: group,
        url: children[0].url,
        icon: groupIcons[group as keyof typeof groupIcons],
        isActive: children.some(
          (item) =>
            pathname === item.url ||
            (item.url !== "/" && pathname.startsWith(`${item.url}/`)),
        ),
        items: children.map(({ title, url }) => ({ title, url })),
      };
    });
  }, [pathname, roleDestinations]);

  const projects = roleDestinations
    .filter((item) => item.url !== "/")
    .map(({ title, url, icon }) => ({
      name: title,
      url,
      icon,
    }));

  const accountName = user.role === "admin" ? "Administrator" : "Panel user";
  const data = {
    user: {
      name: accountName,
      email: user.email,
      avatar: "",
      role: user.role,
    },
    teams: [
      {
        name: "Fledge",
        logo: FledgeMark,
        plan: "Server workspace",
      },
    ],
  };

  return (
    <Sidebar collapsible="icon" className="workspace-sidebar" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={data.teams} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        <NavProjects projects={projects} onMore={onMore} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} onLogout={onLogout} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function FledgeMark({ className }: { className?: string }) {
  return <img src="/fledge-symbol.png" alt="" className={className} />;
}
