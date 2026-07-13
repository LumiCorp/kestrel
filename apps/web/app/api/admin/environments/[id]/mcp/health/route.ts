import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { getEnvironmentMcpOperationalSnapshot } from "@/lib/mcp/control-plane";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const { id } = z.object({ id: routeIdSchema }).parse(await context.params);
    return NextResponse.json(
      await getEnvironmentMcpOperationalSnapshot({
        organizationId,
        environmentId: id,
      })
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
