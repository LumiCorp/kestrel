import {
  SettingsDisclosure,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusSummary,
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
        description="Release alignment across this Environment's Workspaces."
        title="Runtime release"
      >
        <SettingsRows>
          <SettingsRow label="Alignment">
            <SettingsStatusSummary
              detail="Stopped Workspaces apply the release on their next activation."
              status={
                releaseStatus.desiredRuntimeImage
                  ? environment.runtimeImage === releaseStatus.desiredRuntimeImage
                  ? "Current"
                  : "Update pending" : "Bootstrap"
              }
              tone={
                releaseStatus.desiredRuntimeImage
                  ? environment.runtimeImage === releaseStatus.desiredRuntimeImage
                  ? "positive"
                  : "warning" : "neutral"
              }
            />
          </SettingsRow>
          <SettingsRow label="Release status">
            <Badge variant="outline">
              {releaseStatus.rolloutStatus ??
                (releaseStatus.stableReleaseId ? "stable" : "bootstrap")}
            </Badge>
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsDisclosure
        description="Applied and desired image digests, template, and idle policy."
        title="Runtime details"
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
          <SettingsRow label="Runtime template">
            {environment.runtimeTemplate}
          </SettingsRow>
          <SettingsRow label="Idle timeout">
            {environment.idleTimeoutMinutes} minutes
          </SettingsRow>
        </SettingsRows>
      </SettingsDisclosure>

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
