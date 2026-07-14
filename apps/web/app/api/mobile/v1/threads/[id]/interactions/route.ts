import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { listPendingMcpInteractions } from "@/lib/mcp/interactions";
import { mobileInteractionDto } from "@/lib/mobile/dto";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const interactions = await listPendingMcpInteractions({
      organizationId,
      threadId: id,
      userId: session.user.id,
    });
    return NextResponse.json({
      interactions: interactions.map(mobileInteractionDto),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
