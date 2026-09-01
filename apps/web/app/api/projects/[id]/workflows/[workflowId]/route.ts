import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import {
  deleteProjectWorkflow,
  getProjectWorkflowForUser,
  updateProjectWorkflow,
} from "@/lib/workflows/store";

const paramsSchema = z.object({ id: routeIdSchema, workflowId: routeIdSchema });
const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    modelId: z.string().trim().min(1).max(200),
    enabled: z.boolean().optional(),
    definition: z.unknown(),
  })
  .strict();

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string; workflowId: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId, workflowId } = paramsSchema.parse(await context.params);
    return NextResponse.json({ workflow: await getProjectWorkflowForUser({ organizationId, projectId, workflowId, userId: session.user.id }) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string; workflowId: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId, workflowId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const workflow = await updateProjectWorkflow({ organizationId, projectId, workflowId, userId: session.user.id, ...body });
    return NextResponse.json({ workflow });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string; workflowId: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId, workflowId } = paramsSchema.parse(await context.params);
    await deleteProjectWorkflow({ organizationId, projectId, workflowId, userId: session.user.id });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
