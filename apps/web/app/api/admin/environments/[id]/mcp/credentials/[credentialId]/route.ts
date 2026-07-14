import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { revokeEnvironmentMcpCredential } from "@/lib/mcp/control-plane";

const paramsSchema = z.object({
  id: routeIdSchema,
  credentialId: routeIdSchema,
});
const inputSchema = z.object({ status: z.literal("revoked") });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; credentialId: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id, credentialId } = paramsSchema.parse(await context.params);
    inputSchema.parse(await request.json());
    const credential = await revokeEnvironmentMcpCredential({
      organizationId,
      environmentId: id,
      credentialId,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ credential });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
