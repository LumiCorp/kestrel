import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { ReasoningPolicyForm } from "@/app/(workspace)/settings/environments/[id]/reasoning-policy-form";
import { Badge } from "@/components/ui/badge";
import { getEnvironmentFlyImageReleaseStatus } from "@/lib/releases/store";

export default async function OrganizationEnvironmentRuntimePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const [environment, releaseStatus] = await Promise.all([
    getOrganizationEnvironment({
      organizationId,
      environmentId: id,
    }),
    getEnvironmentFlyImageReleaseStatus(id),
  ]);
  if (!environment) return null;

  return (
    <div>
      <SettingsSection
        description="Fly runtime images are managed as coordinated, validated platform releases. Stopped Workspaces are configured without starting and verified on their next activation."
        title="Workspace runtime"
      >
        <SettingsRows>
          <SettingsRow label="Applied image">
            <span className="break-all font-mono text-xs">
              {environment.runtimeImage ?? "Not provisioned"}
            </span>
          </SettingsRow>
          <SettingsRow label="Stable release image">
            <span className="break-all font-mono text-xs">
              {releaseStatus.desiredRuntimeImage ??
                "Bootstrap configuration (no stable release yet)"}
            </span>
          </SettingsRow>
          <SettingsRow label="Release status">
            <Badge variant="outline">
              {releaseStatus.rolloutStatus ??
                (releaseStatus.stableReleaseId ? "stable" : "bootstrap")}
            </Badge>
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
