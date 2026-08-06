import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/knowledge/auth";
import { listFlyImageReleases } from "@/lib/releases/store";
import { getRuntimeDeploymentStatus } from "@/lib/runtime-deployments/store";
import { ReleasesClient } from "./releases-client";

export default async function AdminReleasesPage() {
  await requireAdmin();
  const [releaseData, deployment] = await Promise.all([
    listFlyImageReleases(),
    getRuntimeDeploymentStatus(),
  ]);
  return (
    <div className="space-y-6">
      <AdminPageHeader
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/environments">Environment operations</Link>
          </Button>
        }
        description="See desired and verified runtime state. Deployments reconcile automatically per Environment and Workspace; recovery actions affect only the selected resource."
        eyebrow="Platform operations"
        title="Runtime Deployment"
      />
      <ReleasesClient
        initialDeployment={JSON.parse(JSON.stringify(deployment))}
        legacyReleases={releaseData.releases.map((release) => ({
          id: release.id,
          bundleRevision: release.bundleRevision,
          trigger: release.trigger,
          status: release.status,
          createdAt: release.createdAt.toISOString(),
          failureMessage: release.failureMessage,
        }))}
      />
    </div>
  );
}
