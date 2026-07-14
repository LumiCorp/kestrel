import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { disconnectEnvironmentAppConnection } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  environmentId: routeIdSchema,
  appKey: z.string().trim().min(1).max(160),
  connectionId: routeIdSchema,
});

export async function DELETE(
  _request: Request,
  context: {
    params: Promise<{
      environmentId: string;
      appKey: string;
      connectionId: string;
    }>;
  }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const params = paramsSchema.parse(await context.params);
    const appKey = decodeURIComponent(params.appKey);
    const connection = await disconnectEnvironmentAppConnection({
      organizationId,
      environmentId: params.environmentId,
      appKey,
      connectionId: params.connectionId,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "apps",
      action: "app.connection.disconnected",
      targetType: "app_connection",
      targetId: connection.id,
      message: `Disconnected ${appKey} connection ${connection.name}.`,
      metadata: {
        appKey,
        environmentId: params.environmentId,
        connectionId: connection.id,
      },
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
