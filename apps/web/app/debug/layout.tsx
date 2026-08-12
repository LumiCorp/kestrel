import { AuthenticatedAppShell } from "@/components/authenticated-app-shell";
import { AppPage } from "@/components/app-page";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";

export default async function DebugLayout({
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
      sectionLabel="Debug"
      session={session}
    >
      <AppPage>{children}</AppPage>
    </AuthenticatedAppShell>
  );
}
