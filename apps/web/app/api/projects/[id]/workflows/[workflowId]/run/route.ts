import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { advanceProjectWorkflowRun } from "@/lib/workflows/runtime";
import { createProjectWorkflowRun } from "@/lib/workflows/store";

const paramsSchema = z.object({ id: routeIdSchema, workflowId: routeIdSchema });
const bodySchema = z.object({
  requestId: routeIdSchema,
  input: z.record(z.string(), z.unknown()).optional(),
}).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string; workflowId: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId, workflowId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const run = await createProjectWorkflowRun({
      organizationId,
      projectId,
      workflowId,
      userId: session.user.id,
      requestId: body.requestId,
      runInput: body.input,
    });
    const advanced = await advanceProjectWorkflowRun(run.id);
    await Promise.all(advanced.turnIds.map((turnId) => enqueueDurableThreadTurn(turnId)));
    return NextResponse.json({ runId: run.id }, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
