import {
  SettingsDisclosure,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { ReasoningPolicyForm } from "@/app/(workspace)/settings/environments/[id]/reasoning-policy-form";

export default async function OrganizationEnvironmentRuntimePage({
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
    <div>
      <SettingsSection
        description="Applied runtime configuration. Production changes are performed by a platform operator from the local release tools."
        title="Environment Runtime"
      >
        <SettingsRows>
          <SettingsRow label="Applied Workspace image">
            <span className="break-all font-mono text-xs">
              {environment.runtimeImage ?? "Not provisioned"}
            </span>
          </SettingsRow>
          <SettingsRow label="Applied Router image">
            <span className="break-all font-mono text-xs">
              {environment.routerImage ?? "Not provisioned"}
            </span>
          </SettingsRow>
          <SettingsRow label="Runtime template">
            {environment.runtimeTemplate}
          </SettingsRow>
          <SettingsRow label="Idle timeout">
            {environment.idleTimeoutMinutes} minutes
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsDisclosure
        description="Control what reasoning providers may return and how long Kestrel retains it."
        title="Provider reasoning policy"
      >
        <ReasoningPolicyForm
          environmentId={environment.id}
          initial={{
            requestMode: environment.reasoningRequestMode,
            ...(environment.reasoningEffort
              ? { effort: environment.reasoningEffort }
              : {}),
            retentionMode: environment.reasoningRetentionMode,
            retentionDays: environment.reasoningRetentionDays,
          }}
        />
      </SettingsDisclosure>
    </div>
  );
}
