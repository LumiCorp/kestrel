import { NextResponse } from "next/server";
import { z } from "zod";
import { recoverAdminDefaultEnvironment } from "@/lib/admin/environments";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { getOrganizationChatReadiness } from "@/lib/organizations/chat-readiness";

const bodySchema = z.object({
  action: z.literal("retry-default-environment"),
});

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json({
      readiness: await getOrganizationChatReadiness(organizationId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    bodySchema.parse(await request.json());
    const readinessBeforeRecovery =
      await getOrganizationChatReadiness(organizationId);
    if (!readinessBeforeRecovery.workspaceCompute.ready) {
      return NextResponse.json(
        { error: "Verify the Fly workspace provider before retrying the default Environment." },
        { status: 409 }
      );
    }
    const recovery = await recoverAdminDefaultEnvironment({
      organizationId,
      actorUserId: session.user.id,
    });
    return NextResponse.json(
      {
        recovery: {
          action: recovery.action,
          environmentId: recovery.environment.id,
          operationId: recovery.operation.id,
          operationStatus: recovery.operation.status,
        },
        readiness: await getOrganizationChatReadiness(organizationId),
      },
      { status: recovery.action === "ready" ? 200 : 202 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
