import type { ReactNode } from "react";
import { PageContainer } from "@/components/app-page";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { isAdmin } = await requireAuthenticatedShell();

  return (
    <div className="min-h-full border-t">
      <PageContainer
        className="py-0 sm:py-0 lg:py-0"
        contentClassName="flex flex-col lg:flex-row lg:gap-8"
      >
        <SettingsNavigation isAppAdmin={isAdmin} />
        <main className="min-w-0 flex-1 py-6 sm:py-7 lg:py-8">
          {children}
        </main>
      </PageContainer>
    </div>
  );
}
