import { NextResponse } from "next/server";
import { z } from "zod";
import { updateAdminEnvironmentRuntime } from "@/lib/admin/environments";
import { EnvironmentRuntimeChannelError } from "@/lib/environments/runtime-channel";
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
    const requested = await updateAdminEnvironmentRuntime({
      organizationId,
      actorUserId: session.user.id,
      environmentId: id,
    });
    if (!requested.operation) {
      return NextResponse.json(
        { error: { code: "RUNTIME_ALREADY_CURRENT" } },
        { status: 409 },
      );
    }
    return NextResponse.json({ operation: requested.operation }, { status: 202 });
  } catch (error) {
    if (error instanceof EnvironmentRuntimeChannelError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.code === "RUNTIME_VERSION_NOT_FOUND" ? 404 : 409 },
      );
    }
    return errorResponse(error, 400);
  }
}
