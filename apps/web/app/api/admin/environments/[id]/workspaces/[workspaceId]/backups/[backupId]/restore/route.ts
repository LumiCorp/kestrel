import { NextResponse } from "next/server";
import { restoreWorkspaceBackup } from "@/lib/environments/backups";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(
  _request: Request,
  context: {
    params: Promise<{ id: string; workspaceId: string; backupId: string }>;
  }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const { id, workspaceId, backupId } = await context.params;
    return NextResponse.json(
      await restoreWorkspaceBackup({
        organizationId,
        environmentId: id,
        workspaceId,
        backupId,
        actorUserId: session.user.id,
      })
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
