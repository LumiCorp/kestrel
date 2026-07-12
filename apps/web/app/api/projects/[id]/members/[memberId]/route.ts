import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { removeProjectMember } from "@/lib/projects/store";

const paramsSchema = z.object({ id: routeIdSchema, memberId: routeIdSchema });

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; memberId: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const member = await removeProjectMember({
      projectId: params.id,
      organizationId,
      actorUserId: session.user.id,
      organizationMemberId: params.memberId,
    });
    return member
      ? NextResponse.json({ success: true })
      : NextResponse.json(
          { error: "Project member not found" },
          { status: 404 }
        );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
