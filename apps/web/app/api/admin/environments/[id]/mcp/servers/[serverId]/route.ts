import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import {
  disableEnvironmentMcpServer,
  getEnvironmentMcpServer,
} from "@/lib/mcp/control-plane";

const paramsSchema = z.object({
  id: routeIdSchema,
  serverId: routeIdSchema,
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; serverId: string }> }
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const { id, serverId } = paramsSchema.parse(await context.params);
    return NextResponse.json(
      await getEnvironmentMcpServer({
        organizationId,
        environmentId: id,
        serverId,
      })
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}

const inputSchema = z.object({ status: z.literal("disabled") });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; serverId: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id, serverId } = paramsSchema.parse(await context.params);
    inputSchema.parse(await request.json());
    const server = await disableEnvironmentMcpServer({
      organizationId,
      environmentId: id,
      serverId,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ server });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
