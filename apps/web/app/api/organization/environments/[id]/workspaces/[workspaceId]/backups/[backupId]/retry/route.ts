import { NextResponse } from "next/server";
import { retryFailedDailyWorkspaceBackup } from "@/lib/environments/backups";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; workspaceId: string; backupId: string }> },
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const { id, workspaceId, backupId } = await context.params;
    return NextResponse.json(
      await retryFailedDailyWorkspaceBackup({
        organizationId,
        environmentId: id,
        workspaceId,
        backupId,
      }),
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
