import { AuthenticatedAppShell } from "@/components/authenticated-app-shell";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";

export default async function DebugLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { activeOrganization, isAdmin, session } =
    await requireAuthenticatedShell({
      requireAdmin: true,
      requireActiveOrganization: true,
    });

  return (
    <AuthenticatedAppShell
      activeOrganization={activeOrganization}
      isAdmin={isAdmin}
      sectionLabel="Debug"
      session={session}
    >
      {children}
    </AuthenticatedAppShell>
  );
}
