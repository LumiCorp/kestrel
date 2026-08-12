import { NextResponse } from "next/server";

import { authorizeDesktopConnector } from "@/lib/environments/desktop";
import { renewDesktopRuntimeDescriptorProbeLease } from "@/lib/runtimes/desktop-descriptor-probes";
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
    const lease = await renewDesktopRuntimeDescriptorProbeLease({
      authorization,
      probeId,
      body: JSON.parse(bodyText) as unknown,
    });
    return NextResponse.json({
      id: probeId,
      state: "delivering",
      claimExpiresAt: lease.claimExpiresAt,
    });
  } catch (error) {
    return errorResponse(error, 401);
  }
}
