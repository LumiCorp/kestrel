import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { updateSnapshotConfigForOrganization } from "@/lib/admin/snapshot";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { getSnapshotRepoConfig } from "@/lib/knowledge/snapshot-config";

const bodySchema = z.object({
  snapshotRepo: z.string().trim().min(1),
  snapshotBranch: z.string().trim().optional(),
});

export async function GET() {
  try {
    const { organizationId } = await requireAdminOrganization();
    const config = await getSnapshotRepoConfig(organizationId);
    return NextResponse.json(config);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const body = bodySchema.parse(await request.json());
    const result = await updateSnapshotConfigForOrganization({
      organizationId,
      snapshotRepo: body.snapshotRepo,
      snapshotBranch: body.snapshotBranch,
    });

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "snapshot",
      action: "update-config",
      targetType: "snapshot_config",
      message: `Updated snapshot repository to ${result.snapshotRepo}.`,
      metadata: {
        snapshotRepo: result.snapshotRepo,
        snapshotBranch: result.snapshotBranch,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
