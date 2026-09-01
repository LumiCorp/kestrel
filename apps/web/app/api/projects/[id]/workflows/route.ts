import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import {
  createProjectWorkflow,
  listProjectWorkflowsForUser,
} from "@/lib/workflows/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    modelId: z.string().trim().min(1).max(200),
    enabled: z.boolean().optional(),
    definition: z.unknown(),
  })
  .strict();

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId } = paramsSchema.parse(await context.params);
    return NextResponse.json({
      workflows: await listProjectWorkflowsForUser({ organizationId, userId: session.user.id, projectId }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const workflow = await createProjectWorkflow({
      organizationId,
      projectId,
      userId: session.user.id,
      ...body,
    });
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
