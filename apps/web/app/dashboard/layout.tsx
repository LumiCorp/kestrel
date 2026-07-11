import { AuthenticatedAppShell } from "@/components/authenticated-app-shell";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { activeOrganization, isAdmin, session } =
    await requireAuthenticatedShell();

  return (
    <AuthenticatedAppShell
      activeOrganization={activeOrganization}
      isAdmin={isAdmin}
      sectionLabel="Dashboard"
      session={session}
    >
      {children}
    </AuthenticatedAppShell>
  );
}
