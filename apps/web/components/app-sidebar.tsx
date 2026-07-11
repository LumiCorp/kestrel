"use client";

import type * as React from "react";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { OrganizationSnapshot, Session } from "@/lib/auth-types";

export function AppSidebar({
  activeOrganization,
  session,
  isAdmin,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  activeOrganization: OrganizationSnapshot | null;
  session: Session | null;
  isAdmin: boolean;
}) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher initialActiveOrganization={activeOrganization} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain isAdmin={isAdmin} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser session={session} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
