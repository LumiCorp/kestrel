"use client";

import { ServerCog, Settings, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type SidebarScopeAccess = {
  canManageActiveOrganization: boolean;
  isPlatformAdmin: boolean;
};

export function getSidebarScopeItems(access: SidebarScopeAccess) {
  return [
    ...(access.isPlatformAdmin
      ? [
          {
            href: "/platform/users",
            icon: ServerCog,
            label: "Platform",
            match: (pathname: string) => pathname.startsWith("/platform"),
          },
        ]
      : []),
    ...(access.canManageActiveOrganization
      ? [
          {
            href: "/organization",
            icon: ShieldCheck,
            label: "Admin",
            match: (pathname: string) => pathname.startsWith("/organization"),
          },
        ]
      : []),
    {
      href: "/settings/profile",
      icon: Settings,
      label: "Settings",
      match: (pathname: string) => pathname.startsWith("/settings"),
    },
  ];
}

export function NavScopeFooter(props: SidebarScopeAccess) {
  const pathname = usePathname();
  const items = getSidebarScopeItems(props);

  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton
            asChild
            isActive={item.match(pathname)}
            tooltip={item.label}
          >
            <Link
              aria-current={item.match(pathname) ? "page" : undefined}
              href={item.href}
            >
              <item.icon />
              <span>{item.label}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
