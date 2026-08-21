import { NextResponse } from "next/server";
import { z } from "zod";
import { requestAdminEnvironmentReconciliation } from "@/lib/admin/environments";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({ id: routeIdSchema });

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id } = paramsSchema.parse(await context.params);
    const requested = await requestAdminEnvironmentReconciliation({
      organizationId,
      actorUserId: session.user.id,
      environmentId: id,
    });
    return NextResponse.json(requested, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
