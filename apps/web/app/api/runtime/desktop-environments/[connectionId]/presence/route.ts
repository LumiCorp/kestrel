import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  authorizeDesktopConnector,
  reportDesktopPresence,
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
    const previousCapacity = authorization.connection.capacity;
    const presence = await reportDesktopPresence(
        authorization,
        JSON.parse(bodyText) as unknown,
      );
    if (presence.capacity !== previousCapacity) {
      await logAdminEvent({
        organizationId: authorization.connection.organizationId,
        category: "desktop-environments",
        action: "desktop_environment.capacity.changed",
        targetType: "environment",
        targetId: authorization.environment.id,
        message: `Desktop Environment capacity changed to ${presence.capacity}.`,
        metadata: {
          connectionId,
          previousCapacity,
          capacity: presence.capacity,
        },
      });
    }
    return NextResponse.json(presence);
  } catch (error) {
    return errorResponse(error, 401);
  }
}
