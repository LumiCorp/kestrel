"use client";

import { BookOpen, Bot, PlugZap } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const modeItems = [
  {
    title: "Work",
    url: "/",
    icon: Bot,
    isActive: (pathname: string) =>
      pathname === "/" ||
      pathname.startsWith("/threads") ||
      pathname.startsWith("/projects") ||
      pathname.startsWith("/search"),
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
      <SidebarGroupLabel>Navigate</SidebarGroupLabel>
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
