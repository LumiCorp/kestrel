import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Script from "next/script";
import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DataStreamProvider } from "@/components/chatbot/data-stream-provider";
import { OrganizationReadinessBanner } from "@/components/organization-readiness-banner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceRail } from "@/components/workspace-rail";
import {
  canManageOrganization,
  getActiveOrganizationSnapshot,
} from "@/lib/knowledge/auth";
import { getOrganizationChatReadiness } from "@/lib/organizations/chat-readiness";
import { auth } from "../(auth)/auth";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Script
        src="https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js"
        strategy="beforeInteractive"
      />
      <DataStreamProvider>
        <Suspense fallback={<div className="flex h-dvh" />}>
          <SidebarWrapper>{children}</SidebarWrapper>
        </Suspense>
      </DataStreamProvider>
    </>
  );
}

async function SidebarWrapper({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  const activeOrganization = await getActiveOrganizationSnapshot(session);
  const [readiness, canManageActiveOrganization] = activeOrganization
    ? await Promise.all([
        getOrganizationChatReadiness(activeOrganization.id),
        canManageOrganization({
          organizationId: activeOrganization.id,
          userId: session.user.id,
        }),
      ])
    : [null, false] as const;
  const cookieStore = await cookies();
  const isCollapsed = cookieStore.get("sidebar_state")?.value !== "true";

  return (
    <SidebarProvider
      className="h-dvh overflow-hidden"
      defaultOpen={!isCollapsed}
    >
      <AppSidebar
        activeOrganization={activeOrganization}
        session={session}
      />
      <SidebarInset className="min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
          <WorkspaceRail organizationId={activeOrganization?.id ?? "unknown"} />
          <main
            className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            data-slot="workspace-content"
          >
            {readiness ? (
              <OrganizationReadinessBanner
                canManage={canManageActiveOrganization}
                readiness={readiness}
              />
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </main>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
