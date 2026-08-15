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
import { getEnvironmentRuntimeChannel } from "@/lib/environments/runtime-channel";
import { RuntimeUpdateButton } from "./runtime-update-button";

export default async function OrganizationEnvironmentRuntimePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const [environment, channel] = await Promise.all([
    getOrganizationEnvironment({
      organizationId,
      environmentId: id,
    }),
    getEnvironmentRuntimeChannel(),
  ]);
  if (!environment) return null;
  const aligned = Boolean(
    channel.currentVersion &&
      environment.runtimeImage === channel.currentVersion.runtimeImage &&
      environment.routerImage === channel.currentVersion.routerImage,
  );

  return (
    <div>
      <SettingsSection
        description="Alignment with the production Environment Runtime Channel."
        title="Environment Runtime"
      >
        <SettingsRows>
          <SettingsRow label="Alignment">
            <SettingsStatusSummary
              detail="Updates run through this Environment's durable lifecycle operation."
              status={
                channel.currentVersion
                  ? aligned
                  ? "Current"
                  : "Update available"
                  : "Bootstrap"
              }
              tone={
                channel.currentVersion
                  ? aligned
                  ? "positive"
                  : "warning"
                  : "neutral"
              }
            />
          </SettingsRow>
          <SettingsRow label="Channel generation">
            <Badge variant="outline">
              {channel.generation}
            </Badge>
          </SettingsRow>
          <SettingsRow label="Action">
            <RuntimeUpdateButton
              aligned={aligned}
              environmentId={environment.id}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsDisclosure
        description="Applied and desired image digests, template, and idle policy."
        title="Runtime details"
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
          <SettingsRow label="Current Workspace image">
            <span className="break-all font-mono text-xs">
              {channel.currentVersion?.runtimeImage ?? "No current version"}
            </span>
          </SettingsRow>
          <SettingsRow label="Current Router image">
            <span className="break-all font-mono text-xs">
              {channel.currentVersion?.routerImage ?? "No current version"}
            </span>
          </SettingsRow>
          <SettingsRow label="Previous Workspace image">
            <span className="break-all font-mono text-xs">
              {channel.previousVersion?.runtimeImage ?? "No previous version"}
            </span>
          </SettingsRow>
          <SettingsRow label="Previous Router image">
            <span className="break-all font-mono text-xs">
              {channel.previousVersion?.routerImage ?? "No previous version"}
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
