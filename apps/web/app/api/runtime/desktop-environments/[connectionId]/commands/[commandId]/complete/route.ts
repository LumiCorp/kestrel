import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  authorizeDesktopConnector,
  completeDesktopEnvironmentCommand,
} from "@/lib/environments/desktop";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ connectionId: string; commandId: string }>;
  },
) {
  try {
    const params = await context.params;
    const connectionId = routeIdSchema.parse(params.connectionId);
    const commandId = routeIdSchema.parse(params.commandId);
    const bodyText = await request.text();
    const authorization = await authorizeDesktopConnector({
      request,
      bodyText,
      connectionId,
    });
    const completed = await completeDesktopEnvironmentCommand({
        authorization,
        commandId,
        body: JSON.parse(bodyText) as unknown,
      });
    await logAdminEvent({
      organizationId: authorization.connection.organizationId,
      category: "desktop-environments",
      action: `desktop_environment.task.${completed.status}`,
      targetType: "environment",
      targetId: authorization.environment.id,
      message: `Desktop Environment task ${completed.status}.`,
      metadata: {
        connectionId,
        commandId,
        executionId: completed.executionId,
        workspaceId: completed.workspaceId,
        failureCode: completed.failureCode,
      },
    });
    return NextResponse.json(completed);
  } catch (error) {
    return errorResponse(error, 401);
  }
}
