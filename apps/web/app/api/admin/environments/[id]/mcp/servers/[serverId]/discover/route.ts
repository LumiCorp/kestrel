import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { requestEnvironmentMcpDiscovery } from "@/lib/mcp/control-plane";

const paramsSchema = z.object({
  id: routeIdSchema,
  serverId: routeIdSchema,
});

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; serverId: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id, serverId } = paramsSchema.parse(await context.params);
    const result = await requestEnvironmentMcpDiscovery({
      organizationId,
      environmentId: id,
      serverId,
      actorUserId: session.user.id,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
