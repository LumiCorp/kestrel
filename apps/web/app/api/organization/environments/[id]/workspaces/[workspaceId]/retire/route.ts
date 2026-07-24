import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { requestWorkspaceRetirement } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";

const bodySchema = z.object({
  confirmationName: z.string().trim().min(1).max(120),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; workspaceId: string }> },
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id: environmentId, workspaceId } = await context.params;
    const { confirmationName } = bodySchema.parse(await request.json());
    const operation = await requestWorkspaceRetirement({
      organizationId,
      environmentId,
      workspaceId,
      confirmationName,
      userId: session.user.id,
    });
    if (operation.status === "queued")
      await enqueueEnvironmentOperation(operation.id);
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "workspaces",
      action: "workspace.retire.requested",
      targetType: "workspace",
      targetId: workspaceId,
      message:
        "Requested Workspace retirement, including its machine and persistent volume.",
      metadata: { environmentId, operationId: operation.id },
    }).catch(() => {});
    return NextResponse.json({ operation }, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
