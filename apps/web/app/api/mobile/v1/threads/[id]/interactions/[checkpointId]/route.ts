import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { resolveMcpInteraction } from "@/lib/mcp/interactions";
import { mobileInteractionDto } from "@/lib/mobile/dto";

const paramsSchema = z.object({
  id: routeIdSchema,
  checkpointId: routeIdSchema,
});
const bodySchema = z.object({
  decision: z.enum(["approve", "deny"]),
  content: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    )
    .optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; checkpointId: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const interaction = await resolveMcpInteraction({
      organizationId,
      threadId: params.id,
      userId: session.user.id,
      checkpointId: params.checkpointId,
      ...body,
    });
    return NextResponse.json({
      interaction: mobileInteractionDto(interaction),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
