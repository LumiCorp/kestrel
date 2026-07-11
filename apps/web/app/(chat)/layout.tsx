import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Script from "next/script";
import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DataStreamProvider } from "@/components/chatbot/data-stream-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import {
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
  const cookieStore = await cookies();
  const isCollapsed = cookieStore.get("sidebar_state")?.value !== "true";

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <AppSidebar
        activeOrganization={activeOrganization}
        isAdmin={isAdminUser(
          session?.user as { id?: string | null; role?: string | null } | null
        )}
        session={session}
      />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
