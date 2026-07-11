import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { syncSnapshotForOrganization } from "@/lib/admin/snapshot";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST() {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const result = await syncSnapshotForOrganization(organizationId);

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "snapshot",
      action: "sync",
      targetType: "snapshot",
      targetId: result.snapshotId,
      message: result.created
        ? `Created and marked snapshot ${result.snapshotId} as active.`
        : `Marked snapshot ${result.snapshotId} as active.`,
    });

    return NextResponse.json({
      success: true,
      snapshotId: result.snapshotId,
      created: result.created,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
