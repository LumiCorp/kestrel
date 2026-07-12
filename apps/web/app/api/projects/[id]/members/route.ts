import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { upsertProjectMember } from "@/lib/projects/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.object({
  organizationMemberId: routeIdSchema,
  role: z.enum(["owner", "editor", "member"]),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const member = await upsertProjectMember({
      projectId: params.id,
      organizationId,
      actorUserId: session.user.id,
      ...body,
    });
    return NextResponse.json(member);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
