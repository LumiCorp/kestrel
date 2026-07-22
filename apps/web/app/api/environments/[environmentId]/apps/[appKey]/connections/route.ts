import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { createEnvironmentAppConnectionSchema } from "@/lib/apps/contracts";
import { connectOfficialRemoteTokenApp } from "@/lib/apps/official-remote-connection";
import { saveEnvironmentAppConnection } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  environmentId: routeIdSchema,
  appKey: z.string().trim().min(1).max(160),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ environmentId: string; appKey: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const params = paramsSchema.parse(await context.params);
    const appKey = decodeURIComponent(params.appKey);
    const input = createEnvironmentAppConnectionSchema.parse(
      await request.json()
    );
    const connectionInput = {
      organizationId,
      environmentId: params.environmentId,
      appKey,
      actorUserId: session.user.id,
      connection: input,
    };
    const connection =
      (await connectOfficialRemoteTokenApp(connectionInput)) ??
      (await saveEnvironmentAppConnection(connectionInput));
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "apps",
      action: "app.connection.saved",
      targetType: "app_connection",
      targetId: connection.id,
      message: `Saved ${appKey} connection ${connection.name}.`,
      metadata: {
        appKey,
        environmentId: params.environmentId,
        connectionId: connection.id,
      },
    });
    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
