import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { activateProjectWorkflowVersion } from "@/lib/workflows/store";

const paramsSchema = z.object({ id: routeIdSchema, workflowId: routeIdSchema });

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string; workflowId: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId, workflowId } = paramsSchema.parse(await context.params);
    const activation = await activateProjectWorkflowVersion({
      organizationId,
      projectId,
      workflowId,
      userId: session.user.id,
    });
    return NextResponse.json({
      workflow: activation.workflow,
      version: activation.version.version,
      review: {
        workspaceFiles: true,
        actions: activation.manifest.actions.map((action) => ({
          nodeId: action.nodeId,
          toolId: action.toolId,
          fixedInput: action.fixedInput,
          inputBindings: action.inputBindings,
        })),
      },
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
