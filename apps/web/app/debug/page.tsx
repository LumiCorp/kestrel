import { Terminal } from "lucide-react";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSnapshotStatusForOrganization } from "@/lib/admin/snapshot";
import { requireAdminOrganization } from "@/lib/knowledge/auth";

export default async function DebugOverviewPage() {
  const { organizationId } = await requireAdminOrganization();
  const snapshot = await getSnapshotStatusForOrganization(organizationId);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Inspect developer-facing runtime state, snapshot readiness, and sandbox tooling for the active organization."
        eyebrow="Developer"
        title="Debug"
      />

      <Card>
        <CardHeader>
          <CardTitle>Sandbox</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-muted-foreground text-sm">
            {snapshot.currentSnapshotId
              ? `Current snapshot ${snapshot.currentSnapshotId}`
              : "No active snapshot"}
            {snapshot.needsSync ? " · sync recommended" : ""}
          </div>
          <Button asChild variant="outline">
            <Link href="/debug/sandbox">
              <Terminal className="mr-2 size-4" />
              Open Sandbox
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
