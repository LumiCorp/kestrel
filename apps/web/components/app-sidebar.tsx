"use client";

import type * as React from "react";
import { NavMain } from "@/components/nav-main";
import { NavSettings } from "@/components/nav-settings";
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
  canManageOrganization = false,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  activeOrganization: OrganizationSnapshot | null;
  session: Session | null;
  isAdmin: boolean;
  canManageOrganization?: boolean;
}) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher initialActiveOrganization={activeOrganization} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain />
      </SidebarContent>
      <SidebarFooter>
        <NavSettings
          canManageOrganization={canManageOrganization}
          isAdmin={isAdmin}
        />
        <NavUser session={session} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
