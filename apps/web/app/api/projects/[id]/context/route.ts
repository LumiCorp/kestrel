import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { updateProjectContext } from "@/lib/projects/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  instructions: z.string().trim().max(20_000),
  documentIds: z.array(routeIdSchema).max(250),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const result = await updateProjectContext({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
      ...body,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
