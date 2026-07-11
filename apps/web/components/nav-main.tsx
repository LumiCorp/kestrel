"use client";

import {
  Activity,
  BookOpen,
  Bot,
  Bug,
  Building2,
  Cpu,
  CreditCard,
  FolderKanban,
  KeyRound,
  Logs,
  PlugZap,
  User,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const workspaceItems = [
  {
    title: "Chat",
    url: "/chat",
    icon: Bot,
  },
  {
    title: "Knowledge",
    url: "/knowledge",
    icon: FolderKanban,
  },
];

const accountItems = [
  {
    title: "User",
    url: "/dashboard/user",
    icon: User,
  },
  {
    title: "Billing",
    url: "/dashboard/billing",
    icon: CreditCard,
  },
  {
    title: "API Keys",
    url: "/dashboard/api-keys",
    icon: KeyRound,
  },
  {
    title: "Organizations",
    url: "/dashboard/organizations",
    icon: Building2,
  },
];

const adminItems = [
  {
    title: "Agent",
    url: "/admin/agent",
    icon: Bot,
  },
  {
    title: "Gateways",
    url: "/admin/gateways",
    icon: Cpu,
  },
  {
    title: "Tools",
    url: "/admin/tools",
    icon: PlugZap,
  },
  {
    title: "Users",
    url: "/admin/users",
    icon: Users,
  },
  {
    title: "Billing",
    url: "/admin/billing",
    icon: CreditCard,
  },
  {
    title: "Logs",
    url: "/admin/logs",
    icon: Logs,
  },
  {
    title: "Stats",
    url: "/admin/stats",
    icon: Activity,
  },
  {
    title: "API Keys",
    url: "/admin/api-keys",
    icon: KeyRound,
  },
  {
    title: "Docs",
    url: "/admin/docs",
    icon: BookOpen,
  },
];

const debugItems = [
  {
    title: "Overview",
    url: "/debug",
    icon: Bug,
  },
  {
    title: "Sandbox",
    url: "/debug/sandbox",
    icon: Wrench,
  },
];

function isActivePath(pathname: string, itemUrl: string) {
  return pathname === itemUrl || pathname.startsWith(`${itemUrl}/`);
}

function NavSection({
  label,
  items,
  pathname,
}: {
  label: string;
  items: Array<{ title: string; url: string; icon: typeof User }>;
  pathname: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const isActive = isActivePath(pathname, item.url);

          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                isActive={isActive}
                tooltip={item.title}
              >
                <Link href={item.url}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

export function NavMain({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();

  return (
    <>
      <NavSection
        items={workspaceItems}
        label="Workspace"
        pathname={pathname}
      />
      <NavSection items={accountItems} label="Account" pathname={pathname} />
      {isAdmin ? (
        <>
          <NavSection items={adminItems} label="Admin" pathname={pathname} />
          <NavSection items={debugItems} label="Debug" pathname={pathname} />
        </>
      ) : null}
    </>
  );
}
