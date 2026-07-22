import { AuthenticatedAppShell } from "@/components/authenticated-app-shell";
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
      {children}
    </AuthenticatedAppShell>
  );
}
