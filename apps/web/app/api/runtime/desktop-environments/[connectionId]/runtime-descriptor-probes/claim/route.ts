import { NextResponse } from "next/server";

import { authorizeDesktopConnector } from "@/lib/environments/desktop";
import { claimDesktopRuntimeDescriptorProbe } from "@/lib/runtimes/desktop-descriptor-probes";
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
    const claimed = await claimDesktopRuntimeDescriptorProbe(authorization);
    return claimed
      ? NextResponse.json(claimed)
      : new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 401);
  }
}
