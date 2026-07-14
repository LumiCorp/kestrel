import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Script from "next/script";
import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DataStreamProvider } from "@/components/chatbot/data-stream-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceRail } from "@/components/workspace-rail";
import {
  canManageOrganization,
  getActiveOrganizationSnapshot,
  isAdminUser,
} from "@/lib/knowledge/auth";
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
  const canManageActiveOrganization = activeOrganization
    ? await canManageOrganization({
        organizationId: activeOrganization.id,
        userId: session.user.id,
      })
    : false;
  const cookieStore = await cookies();
  const isCollapsed = cookieStore.get("sidebar_state")?.value !== "true";

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <AppSidebar
        activeOrganization={activeOrganization}
        canManageOrganization={canManageActiveOrganization}
        isAdmin={isAdminUser(
          session?.user as { id?: string | null; role?: string | null } | null
        )}
        session={session}
      />
      <SidebarInset>
        <div className="flex min-h-dvh min-w-0 flex-col md:flex-row">
          <WorkspaceRail />
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
