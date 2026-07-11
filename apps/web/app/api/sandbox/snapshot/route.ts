import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { createSnapshotForOrganization } from "@/lib/knowledge/jobs";
import { getSnapshotRepoConfig } from "@/lib/knowledge/snapshot-config";

export async function POST() {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const [job, snapshotConfig] = await Promise.all([
      createSnapshotForOrganization(organizationId),
      getSnapshotRepoConfig(organizationId),
    ]);

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "snapshot",
      action: "create",
      targetType: "snapshot",
      targetId: job.snapshotId,
      message: `Created snapshot ${job.snapshotId}.`,
      metadata: {
        snapshotRepo: snapshotConfig.snapshotRepo || null,
        snapshotBranch: snapshotConfig.snapshotBranch || "main",
      },
    });

    return NextResponse.json({
      status: "started",
      runId: job.runId,
      snapshotId: job.snapshotId,
      snapshotRepo: snapshotConfig.snapshotRepo || null,
      snapshotBranch: snapshotConfig.snapshotBranch || "main",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
