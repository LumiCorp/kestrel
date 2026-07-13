import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { reviewEnvironmentMcpSnapshot } from "@/lib/mcp/control-plane";

const paramsSchema = z.object({
  id: routeIdSchema,
  serverId: routeIdSchema,
  snapshotId: routeIdSchema,
});
const inputSchema = z.object({ decision: z.enum(["approve", "reject"]) });

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ id: string; serverId: string; snapshotId: string }>;
  }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id, serverId, snapshotId } = paramsSchema.parse(
      await context.params
    );
    const { decision } = inputSchema.parse(await request.json());
    const snapshot = await reviewEnvironmentMcpSnapshot({
      organizationId,
      environmentId: id,
      serverId,
      snapshotId,
      actorUserId: session.user.id,
      decision,
    });
    return NextResponse.json({ snapshot });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
