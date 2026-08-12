import { AuthenticatedAppShell } from "@/components/authenticated-app-shell";
import { AppPage } from "@/components/app-page";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";

export default async function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const {
    activeOrganization,
    session,
  } =
    await requireAuthenticatedShell({
      requireActiveOrganization: true,
    });

  return (
    <AuthenticatedAppShell
      activeOrganization={activeOrganization}
      sectionLabel="Knowledge"
      session={session}
    >
      <AppPage>{children}</AppPage>
    </AuthenticatedAppShell>
  );
}
