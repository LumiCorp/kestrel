import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { EnvironmentDeleteAction } from "@/app/(workspace)/settings/environments/[id]/environment-delete-action";
import { EnvironmentOverviewActions } from "@/app/(workspace)/settings/environments/[id]/environment-overview-actions";

export default async function EnvironmentOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const environment = await getOrganizationEnvironment({
    organizationId,
    environmentId: id,
  });
  if (!environment) return null;

  return (
    <div className="space-y-8">
      <SettingsSection
        description="Core identity and lifecycle state for this execution plane."
        title="Environment details"
      >
        <SettingsRows>
          <SettingsRow label="Region">{environment.region}</SettingsRow>
          <SettingsRow label="Runtime template">
            {environment.runtimeTemplate}
          </SettingsRow>
          <SettingsRow label="Idle timeout">
            {environment.idleTimeoutMinutes} minutes
          </SettingsRow>
          <SettingsRow label="Lifecycle status">{environment.status}</SettingsRow>
          {environment.failureCode ? (
            <SettingsRow label="Failure code">
              <span className="font-mono text-destructive text-xs">
                {environment.failureCode}
              </span>
            </SettingsRow>
          ) : null}
          {environment.failureMessage ? (
            <SettingsRow label="Failure details">
              <span className="text-destructive text-sm">
                {environment.failureMessage}
              </span>
            </SettingsRow>
          ) : null}
          <SettingsRow label="Default Environment">
            <EnvironmentOverviewActions
              environmentId={environment.id}
              initialIsDefault={environment.isDefault}
            />
          </SettingsRow>
          <SettingsRow label="Preview ingress">Kestrel Edge</SettingsRow>
        </SettingsRows>
      </SettingsSection>
      <SettingsSection
        description="Deletion permanently removes this Environment's Fly app and Workspace volumes."
        title="Danger zone"
      >
        <EnvironmentDeleteAction
          environmentId={environment.id}
          environmentName={environment.name}
          isDefault={environment.isDefault}
          status={environment.status}
        />
      </SettingsSection>
    </div>
  );
}
