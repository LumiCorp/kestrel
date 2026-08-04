import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
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
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/environments">Environment operations</Link>
          </Button>
        }
        description="Approve one coordinated image bundle, watch canary and sequential Environment rollout, and explicitly retry or roll back paused releases."
        eyebrow="Platform operations"
        title="Fly Image Releases"
      />
      <ReleasesClient
        canaries={canaries}
        initialReleases={releaseData.releases.map((release) => ({
          id: release.id,
          bundleRevision: release.bundleRevision,
          trigger: release.trigger,
          status: release.status,
          migrationChanged: release.migrationChanged,
          migrationApprovedAt: release.migrationApprovedAt?.toISOString() ?? null,
          failureMessage: release.failureMessage,
          createdAt: release.createdAt.toISOString(),
          components: release.components.map((component) => ({
            role: component.role,
            image: component.image,
            changed: component.changed,
          })),
          targets: release.targets.map((target) => ({
            targetKey: target.targetKey,
            status: target.status,
            stage: target.stage,
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
