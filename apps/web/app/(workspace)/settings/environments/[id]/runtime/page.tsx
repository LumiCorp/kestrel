import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { ReasoningPolicyForm } from "../reasoning-policy-form";
import { RuntimeImageForm } from "./runtime-image-form";

export default async function EnvironmentRuntimePage({
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
        description="Choose the immutable image used when Kestrel builds or rebuilds Workspaces."
        title="Workspace runtime"
      >
        <SettingsRows>
          <SettingsRow label="Runtime image">
            <RuntimeImageForm
              environmentId={environment.id}
              initialRuntimeImage={environment.runtimeImage ?? ""}
            />
          </SettingsRow>
          <SettingsRow label="Runtime template">
            {environment.runtimeTemplate}
          </SettingsRow>
          <SettingsRow label="Idle timeout">
            {environment.idleTimeoutMinutes} minutes
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>
      <SettingsSection
        description="Control what reasoning providers may return and how long Kestrel retains it."
        title="Provider reasoning"
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
      </SettingsSection>
    </div>
  );
}
