import type { ReactNode } from "react";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { requireAuthenticatedShell } from "@/lib/knowledge/auth";
import { isPersonalOrganizationSlug } from "@/lib/personal-workspace-shared";

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { activeOrganization, canManageActiveOrganization, isAdmin } =
    await requireAuthenticatedShell();

  return (
    <div className="min-h-full border-t">
      <div className="border-b px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-[100rem]">
          <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Personal, organization, and platform configuration in one place.
          </p>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[100rem] flex-col lg:flex-row">
        <SettingsNavigation
          canManageOrganization={canManageActiveOrganization}
          isAppAdmin={isAdmin}
          showOrganizationSetup={
            !isPersonalOrganizationSlug(activeOrganization?.slug)
          }
        />
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
