import { NextResponse } from "next/server";
import {
  authorizeDesktopConnector,
  syncDesktopWorkspaceCatalog,
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
    return NextResponse.json({
      workspaces: await syncDesktopWorkspaceCatalog(
        authorization,
        JSON.parse(bodyText) as unknown,
      ),
    });
  } catch (error) {
    return errorResponse(error, 401);
  }
}
