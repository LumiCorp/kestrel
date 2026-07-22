import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { EnvironmentAccessForm } from "@/app/(workspace)/settings/environments/[id]/access/environment-access-form";

export default async function EnvironmentAccessPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOrganizationAdmin();
  const { id } = await params;

  return (
    <div>
      <SettingsSection
        description="Personal identities are connected once and intersected with this Environment's policy."
        title="Identity"
      >
        <SettingsRows>
          <SettingsRow
            description="Manage the GitHub account used when your runs receive repository access."
            label="GitHub"
          >
            <a
              className="font-medium text-sm underline-offset-4 hover:underline"
              href="/settings/profile"
            >
              Manage my GitHub connection
            </a>
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>
      <SettingsSection
        description="Set the maximum GitHub authority any Project or run in this Environment can receive."
        title="Capability ceiling"
      >
        <EnvironmentAccessForm environmentId={id} />
      </SettingsSection>
    </div>
  );
}
