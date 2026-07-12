import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { updateThreadSharingForUser } from "@/lib/threads/store";

const bodySchema = z.object({
  isPublic: z.boolean(),
});

const paramsSchema = z.object({
  id: routeIdSchema,
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());

    const thread = await updateThreadSharingForUser({
      id: params.id,
      userId: session.user.id,
      organizationId,
      isPublic: body.isPublic,
    });

    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    return NextResponse.json(thread);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
