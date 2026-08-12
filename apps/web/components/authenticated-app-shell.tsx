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
  sectionLabel,
  session,
}: {
  activeOrganization: OrganizationSnapshot | null;
  children: ReactNode;
  sectionLabel: string;
  session: Session;
}) {
  return (
    <SidebarProvider>
      <AppSidebar
        activeOrganization={activeOrganization}
        session={session}
      />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
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
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
