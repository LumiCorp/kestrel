import { AuthenticatedAppShell } from "@/components/authenticated-app-shell";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";

export default async function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { activeOrganization, isAdmin, session } =
    await requireAuthenticatedShell({
      requireActiveOrganization: true,
    });

  return (
    <AuthenticatedAppShell
      activeOrganization={activeOrganization}
      isAdmin={isAdmin}
      sectionLabel="Knowledge"
      session={session}
    >
      {children}
    </AuthenticatedAppShell>
  );
}
