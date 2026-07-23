"use client";

import { Building2, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  organization,
  useActiveOrganization,
  useListOrganizations,
} from "@/lib/auth-client";
import type { OrganizationSnapshot } from "@/lib/auth-types";
import { isPersonalOrganization } from "@/lib/personal-workspace-shared";
import { cn } from "@/lib/utils";
import { CreateOrganizationDialog } from "./create-organization-dialog";

export function TeamSwitcher({
  initialActiveOrganization = null,
}: {
  initialActiveOrganization?: OrganizationSnapshot | null;
}) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const organizations = useListOrganizations();
  const activeOrgData = useActiveOrganization();
  const [activeOrgId, setActiveOrgId] = useState<string | null>(
    initialActiveOrganization?.id ?? activeOrgData.data?.id ?? null
  );
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null);

  const personalOrg =
    organizations.data?.find((org: any) => isPersonalOrganization(org)) ?? null;
  const teamOrganizations =
    organizations.data?.filter((org: any) => !isPersonalOrganization(org)) ??
    [];

  useEffect(() => {
    if (activeOrgData.data?.id) {
      setActiveOrgId(activeOrgData.data.id);
    } else if (initialActiveOrganization?.id) {
      setActiveOrgId(initialActiveOrganization.id);
    } else if (personalOrg?.id) {
      setActiveOrgId(personalOrg.id);
    } else {
      setActiveOrgId(null);
    }
  }, [activeOrgData.data?.id, initialActiveOrganization?.id, personalOrg?.id]);

  const activeOrg =
    organizations.data?.find((org: any) => org.id === activeOrgId) ??
    (initialActiveOrganization?.id === activeOrgId
      ? initialActiveOrganization
      : null) ??
    personalOrg;
  const activeIsPersonal = isPersonalOrganization(activeOrg);

  const handleSetActive = async (orgId: string) => {
    if (orgId === activeOrgId || pendingOrgId) {
      return;
    }
    const previousOrgId = activeOrgId;
    setActiveOrgId(orgId);
    setPendingOrgId(orgId);

    try {
      const { data, error } = await organization.setActive({
        organizationId: orgId,
      });
      if (error || !data) {
        throw new Error(error?.message || "Organization switch failed");
      }
      router.refresh();
    } catch {
      setActiveOrgId(previousOrgId);
      toast.error("Organization could not be changed");
    } finally {
      setPendingOrgId(null);
    }
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              aria-label="Switch organization"
              className="h-9 gap-1.5 px-2 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              tooltip="Switch organization"
            >
              <Building2 className="hidden size-4 group-data-[collapsible=icon]:block" />
              <span className="min-w-0 flex-1 truncate font-medium group-data-[collapsible=icon]:hidden">
                {activeIsPersonal ? "Personal" : activeOrg?.name || "Personal"}
              </span>
              <ChevronsUpDown className="ml-auto size-3.5 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Organizations
            </DropdownMenuLabel>
            {personalOrg ? (
              <DropdownMenuItem
                className={cn(
                  activeIsPersonal &&
                    "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground focus:bg-sidebar-primary focus:text-sidebar-primary-foreground data-[highlighted]:bg-sidebar-primary data-[highlighted]:text-sidebar-primary-foreground"
                )}
                disabled={pendingOrgId !== null}
                onClick={() => void handleSetActive(personalOrg.id)}
              >
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <span className="font-semibold text-xs">P</span>
                </div>
                Personal
                {activeIsPersonal && (
                  <DropdownMenuShortcut className="text-sidebar-primary-foreground/80">
                    ⌘1
                  </DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
            ) : null}
            {teamOrganizations.map((org: any, index: number) => (
              <DropdownMenuItem
                className={cn(
                  org.id === activeOrgId &&
                    "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground focus:bg-sidebar-primary focus:text-sidebar-primary-foreground data-[highlighted]:bg-sidebar-primary data-[highlighted]:text-sidebar-primary-foreground"
                )}
                disabled={pendingOrgId !== null}
                key={org.id}
                onClick={() => void handleSetActive(org.id)}
              >
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <Building2 className="size-3.5 shrink-0" />
                </div>
                {org.name}
                {org.id === activeOrgId && (
                  <DropdownMenuShortcut className="text-sidebar-primary-foreground/80">
                    ⌘{index + (personalOrg ? 2 : 1)}
                  </DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <CreateOrganizationDialog>
              <DropdownMenuItem
                className="gap-2 p-2"
                onSelect={(e) => e.preventDefault()}
              >
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <Plus className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">
                  Add organization
                </div>
              </DropdownMenuItem>
            </CreateOrganizationDialog>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
