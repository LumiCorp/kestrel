"use client";

import type * as React from "react";
import { useState } from "react";
import { BrandHomeLink } from "@/components/brand";
import { NavMain } from "@/components/nav-main";
import { NavScopeFooter } from "@/components/nav-scope-footer";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { OrganizationSnapshot, Session } from "@/lib/auth-types";

export function AppSidebar({
  activeOrganization,
  canManageActiveOrganization,
  isPlatformAdmin,
  session,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  activeOrganization: OrganizationSnapshot | null;
  canManageActiveOrganization: boolean;
  isPlatformAdmin: boolean;
  session: Session | null;
}) {
  const [organizationSwitchPending, setOrganizationSwitchPending] =
    useState(false);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="h-12 justify-start group-data-[collapsible=icon]:justify-center"
              size="lg"
              tooltip="Kestrel One home"
            >
              <BrandHomeLink />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <TeamSwitcher
          canManageActiveOrganization={canManageActiveOrganization}
          initialActiveOrganization={activeOrganization}
          onSwitchPendingChange={setOrganizationSwitchPending}
        />
      </SidebarHeader>
      <SidebarContent>
        <NavMain />
      </SidebarContent>
      <SidebarFooter>
        <NavScopeFooter
          canManageActiveOrganization={
            !organizationSwitchPending && canManageActiveOrganization
          }
          isPlatformAdmin={isPlatformAdmin}
        />
        <NavUser session={session} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
