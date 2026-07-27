import { NextResponse } from "next/server";
import {
  appendDesktopCommandEvents,
  authorizeDesktopConnector,
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
    return NextResponse.json(
      await appendDesktopCommandEvents({
        authorization,
        commandId,
        body: JSON.parse(bodyText) as unknown,
      }),
    );
  } catch (error) {
    return errorResponse(error, 401);
  }
}
