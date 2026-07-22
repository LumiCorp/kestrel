import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { startEnvironmentMcpOauth } from "@/lib/mcp/oauth-flow";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id } = z.object({ id: routeIdSchema }).parse(await context.params);
    const origin = new URL(request.url).origin;
    const result = await startEnvironmentMcpOauth({
      organizationId,
      environmentId: id,
      actorUserId: session.user.id,
      redirectUri: `${origin}/api/organization/environments/${id}/mcp/oauth/callback`,
      oauth: await request.json(),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
