import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { requireAdmin } from "@/lib/knowledge/auth";
import {
  listFlyImageReleaseCanaries,
  listFlyImageReleases,
} from "@/lib/releases/store";
import { ReleasesClient } from "./releases-client";

export default async function AdminReleasesPage() {
  await requireAdmin();
  const [releaseData, canaries] = await Promise.all([
    listFlyImageReleases(),
    listFlyImageReleaseCanaries(),
  ]);
  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Approve the next coordinated image bundle or recover an interrupted rollout."
        eyebrow="Platform"
        title="Releases"
      />
      <ReleasesClient
        canaries={canaries}
        compatibilityMode={releaseData.compatibilityMode}
        currentBuildRevision={releaseData.currentBuildRevision}
        rollbackEligibility={releaseData.rollbackEligibility}
        initialReleases={releaseData.releases.map((release) => ({
          id: release.id,
          bundleRevision: release.bundleRevision,
          trigger: release.trigger,
          status: release.status,
          migrationChanged: release.migrationChanged,
          migrationApprovedAt:
            release.migrationApprovedAt?.toISOString() ?? null,
          failureMessage: release.failureMessage,
          createdAt: release.createdAt.toISOString(),
          environmentGatewayConfigVersion:
            release.environmentGatewayConfigVersion,
          admission: release.admission,
          recoveryEligibility: release.recoveryEligibility,
          migrationAcknowledgementEligibility:
            release.migrationAcknowledgementEligibility,
          resolvedTargetCount: release.resolvedTargetCount,
          totalTargetCount: release.totalTargetCount,
          components: release.components.map((component) => ({
            role: component.role,
            image: component.image,
            changed: component.changed,
            environmentGatewayAcceptedVersions:
              component.environmentGatewayAcceptedVersions,
          })),
          targets: release.targets.map((target) => ({
            targetKey: target.targetKey,
            status: target.status,
            stage: target.stage,
            result: target.result,
          })),
        }))}
        initialSettings={
          releaseData.settings
            ? {
                stableReleaseId: releaseData.settings.stableReleaseId,
                activeReleaseId: releaseData.settings.activeReleaseId,
                canaryEnvironmentId: releaseData.settings.canaryEnvironmentId,
              }
            : null
        }
      />
    </div>
  );
}
