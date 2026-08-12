import { AuthenticatedAppShell } from "@/components/authenticated-app-shell";
import { AppPage } from "@/components/app-page";
import { AdminNavigation } from "@/components/admin/admin-navigation";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const {
    activeOrganization,
    session,
  } =
    await requireAuthenticatedShell({
      requireAdmin: true,
      requireActiveOrganization: true,
    });

  return (
    <AuthenticatedAppShell
      activeOrganization={activeOrganization}
      sectionLabel="Admin"
      session={session}
    >
      <AppPage>
        <AdminNavigation />
        {children}
      </AppPage>
    </AuthenticatedAppShell>
  );
}
