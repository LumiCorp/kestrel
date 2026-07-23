import { NextResponse } from "next/server";
import { requestFailedWorkspaceProvisionRetry } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; workspaceId: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id, workspaceId } = await context.params;
    const operation = await requestFailedWorkspaceProvisionRetry({
      organizationId,
      environmentId: id,
      workspaceId,
      userId: session.user.id,
    });
    if (!operation) {
      return NextResponse.json(
        { error: "Workspace has no failed provisioning operation to retry." },
        { status: 409 }
      );
    }
    if (operation.status === "queued") {
      await enqueueEnvironmentOperation(operation.id);
    }
    return NextResponse.json({ operation }, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
