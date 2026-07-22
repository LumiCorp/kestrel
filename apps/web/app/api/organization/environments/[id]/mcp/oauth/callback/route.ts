import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { completeEnvironmentMcpOauth } from "@/lib/mcp/oauth-flow";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id } = z.object({ id: routeIdSchema }).parse(await context.params);
    const url = new URL(request.url);
    const query = z
      .object({ state: z.string().min(1), code: z.string().min(1) })
      .parse(Object.fromEntries(url.searchParams));
    await completeEnvironmentMcpOauth({
      organizationId,
      environmentId: id,
      actorUserId: session.user.id,
      ...query,
    });
    return NextResponse.redirect(
      new URL(
        "/settings/organization/environments?mcp_oauth=connected",
        url.origin
      )
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
