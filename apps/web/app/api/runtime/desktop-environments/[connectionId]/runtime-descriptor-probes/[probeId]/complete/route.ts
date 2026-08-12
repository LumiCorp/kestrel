import { NextResponse } from "next/server";

import { authorizeDesktopConnector } from "@/lib/environments/desktop";
import { completeDesktopRuntimeDescriptorProbe } from "@/lib/runtimes/desktop-descriptor-probes";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ connectionId: string; probeId: string }>;
  },
) {
  try {
    const params = await context.params;
    const connectionId = routeIdSchema.parse(params.connectionId);
    const probeId = routeIdSchema.parse(params.probeId);
    const bodyText = await request.text();
    const authorization = await authorizeDesktopConnector({
      request,
      bodyText,
      connectionId,
    });
    const completed = await completeDesktopRuntimeDescriptorProbe({
      authorization,
      probeId,
      body: JSON.parse(bodyText) as unknown,
    });
    return NextResponse.json({
      id: completed.id,
      state: completed.state,
      completedAt: completed.completedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return errorResponse(error, 401);
  }
}
