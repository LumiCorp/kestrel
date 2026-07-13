import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { listPendingMcpInteractions } from "@/lib/mcp/interactions";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = z.object({ id: routeIdSchema }).parse(await context.params);
    const interactions = await listPendingMcpInteractions({
      organizationId,
      threadId: id,
      userId: session.user.id,
    });
    return NextResponse.json({ interactions });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
