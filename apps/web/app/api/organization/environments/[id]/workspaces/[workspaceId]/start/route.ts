import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { requestWorkspaceStart } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; workspaceId: string }> },
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id: environmentId, workspaceId } = await context.params;
    const operation = await requestWorkspaceStart({
      organizationId,
      environmentId,
      workspaceId,
      userId: session.user.id,
    });
    if (operation.status === "queued")
      await enqueueEnvironmentOperation(operation.id);
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "workspaces",
      action: "workspace.start.requested",
      targetType: "workspace",
      targetId: workspaceId,
      message: "Requested Workspace start.",
      metadata: { environmentId, operationId: operation.id },
    }).catch(() => {});
    return NextResponse.json({ operation }, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
