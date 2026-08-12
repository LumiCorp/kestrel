import { NextResponse } from "next/server";
import {
  authorizeDesktopConnector,
  renewDesktopRuntimeReleaseLease,
} from "@/lib/environments/desktop";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string; releaseId: string }> },
) {
  try {
    const params = await context.params;
    const connectionId = routeIdSchema.parse(params.connectionId);
    const releaseId = routeIdSchema.parse(params.releaseId);
    const bodyText = await request.text();
    const authorization = await authorizeDesktopConnector({
      request,
      bodyText,
      connectionId,
    });
    return NextResponse.json(
      await renewDesktopRuntimeReleaseLease({
        authorization,
        releaseId,
        body: JSON.parse(bodyText) as unknown,
      }),
    );
  } catch (error) {
    return errorResponse(error, 401);
  }
}
