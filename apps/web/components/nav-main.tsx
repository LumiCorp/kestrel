"use client";

import {
  BookOpen,
  Bot,
  CalendarClock,
  GitBranch,
  LayoutDashboard,
  MailPlus,
  PlugZap,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const modeItems = [
  {
    title: "Dashboard",
    url: "/dashboard",
    icon: LayoutDashboard,
    isActive: (pathname: string) => pathname === "/dashboard",
  },
  {
    title: "Work",
    url: "/projects",
    icon: Bot,
    isActive: (pathname: string) =>
      pathname.startsWith("/threads") ||
      pathname.startsWith("/projects") ||
      pathname.startsWith("/search"),
  },
  {
    title: "Schedules",
    url: "/schedules",
    icon: CalendarClock,
    isActive: (pathname: string) =>
      pathname === "/schedules" || pathname.startsWith("/schedules/"),
  },
  {
    title: "Workflows",
    url: "/workflows",
    icon: GitBranch,
    isActive: (pathname: string) =>
      pathname === "/workflows" || pathname.startsWith("/workflows/"),
  },
  {
    title: "Triggers",
    url: "/triggers",
    icon: MailPlus,
    isActive: (pathname: string) =>
      pathname === "/triggers" || pathname.startsWith("/triggers/"),
  },
  {
    title: "Knowledge",
    url: "/knowledge",
    icon: BookOpen,
    isActive: (pathname: string) =>
      pathname === "/knowledge" || pathname.startsWith("/knowledge/"),
  },
  {
    title: "Apps",
    url: "/apps",
    icon: PlugZap,
    isActive: (pathname: string) =>
      pathname === "/apps" || pathname.startsWith("/apps/"),
  },
];

export function NavMain() {
  const pathname = usePathname();

  return (
    <SidebarGroup>
      <SidebarMenu>
        {modeItems.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton
              asChild
              isActive={item.isActive(pathname)}
              tooltip={item.title}
            >
              <Link href={item.url}>
                <item.icon />
                <span>{item.title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
