import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { setEnvironmentMcpCapabilityPolicy } from "@/lib/mcp/control-plane";

const paramsSchema = z.object({
  id: routeIdSchema,
  capabilityId: routeIdSchema,
});
const inputSchema = z.object({
  enabled: z.boolean(),
  approvalMode: z.enum(["auto", "ask", "deny"]),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; capabilityId: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id, capabilityId } = paramsSchema.parse(await context.params);
    const policy = inputSchema.parse(await request.json());
    const capability = await setEnvironmentMcpCapabilityPolicy({
      organizationId,
      environmentId: id,
      capabilityId,
      actorUserId: session.user.id,
      ...policy,
    });
    return NextResponse.json({ capability });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
