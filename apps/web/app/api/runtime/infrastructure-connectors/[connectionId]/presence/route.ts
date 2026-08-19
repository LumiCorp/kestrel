import { NextResponse } from "next/server";
import {
  authorizeKubernetesConnector,
  recordKubernetesConnectorPresence,
} from "@/lib/environments/kubernetes-connector";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  try {
    const connectionId = routeIdSchema.parse((await context.params).connectionId);
    const bodyText = await request.text();
    const authorization = await authorizeKubernetesConnector({ request, bodyText, connectionId });
    return NextResponse.json(
      await recordKubernetesConnectorPresence(authorization, JSON.parse(bodyText)),
    );
  } catch (error) {
    return errorResponse(error, 401);
  }
}
