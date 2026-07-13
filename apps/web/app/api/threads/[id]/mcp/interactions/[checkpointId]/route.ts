import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { resolveMcpInteraction } from "@/lib/mcp/interactions";

const inputSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  content: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    )
    .optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; checkpointId: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id, checkpointId } = z
      .object({ id: routeIdSchema, checkpointId: routeIdSchema })
      .parse(await context.params);
    const body = inputSchema.parse(await request.json());
    const interaction = await resolveMcpInteraction({
      organizationId,
      threadId: id,
      userId: session.user.id,
      checkpointId,
      ...body,
    });
    return NextResponse.json({ interaction });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
