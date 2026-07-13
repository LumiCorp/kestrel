import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import type { OrganizationSnapshot, Session } from "@/lib/auth-types";

export function AuthenticatedAppShell({
  activeOrganization,
  children,
  isAdmin,
  sectionLabel,
  session,
}: {
  activeOrganization: OrganizationSnapshot | null;
  children: ReactNode;
  isAdmin: boolean;
  sectionLabel: string;
  session: Session;
}) {
  return (
    <SidebarProvider>
      <AppSidebar
        activeOrganization={activeOrganization}
        canManageOrganization={isAdmin}
        isAdmin={isAdmin}
        session={session}
      />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              className="mr-2 data-[orientation=vertical]:h-4"
              orientation="vertical"
            />
            <div className="font-medium text-sm">{sectionLabel}</div>
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
