import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  authorizeDesktopConnector,
  claimDesktopEnvironmentCommand,
} from "@/lib/environments/desktop";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  try {
    const connectionId = routeIdSchema.parse(
      (await context.params).connectionId,
    );
    const bodyText = await request.text();
    const authorization = await authorizeDesktopConnector({
      request,
      bodyText,
      connectionId,
    });
    const claimed = await claimDesktopEnvironmentCommand(
      authorization,
      JSON.parse(bodyText) as unknown,
    );
    if (claimed) {
      await logAdminEvent({
        organizationId: authorization.connection.organizationId,
        category: "desktop-environments",
        action: "desktop_environment.task.claimed",
        targetType: "environment",
        targetId: authorization.environment.id,
        message: "Desktop Environment claimed a queued task.",
        metadata: {
          connectionId,
          commandId: claimed.command.id,
          executionId: claimed.command.executionId,
          workspaceId: claimed.command.workspaceId,
        },
      });
    }
    return claimed
      ? NextResponse.json(claimed)
      : new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 401);
  }
}
