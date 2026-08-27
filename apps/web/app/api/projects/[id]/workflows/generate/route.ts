import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { requireProjectRole } from "@/lib/projects/access";
import { generateProjectWorkflowDefinition } from "@/lib/workflows/generate";
import {
  assertWorkflowModelSupported,
  getAllowedProjectWorkflowToolNames,
} from "@/lib/workflows/server-policy";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.object({
  description: z.string().trim().min(1).max(20_000),
  modelId: z.string().trim().min(1).max(200),
}).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const access = await requireProjectRole({
      projectId,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    const [allowedToolNames] = await Promise.all([
      getAllowedProjectWorkflowToolNames({
        projectId,
        organizationId,
        userId: session.user.id,
      }),
      assertWorkflowModelSupported({
        organizationId,
        environmentId: access.project.environmentId,
        modelId: body.modelId,
      }),
    ]);
    const definition = await generateProjectWorkflowDefinition({
      description: body.description,
      modelId: body.modelId,
      organizationId,
      environmentId: access.project.environmentId,
      allowedToolNames: [...allowedToolNames],
    });
    return NextResponse.json({ definition });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
