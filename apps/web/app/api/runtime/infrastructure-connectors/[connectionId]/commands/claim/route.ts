import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authorizeKubernetesConnector,
  kubernetesConnectorRuntime,
} from "@/lib/environments/kubernetes-connector";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const bodySchema = z.object({ resumeCommandIds: z.array(z.string()).max(100) }).strict();

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    const connectionId = routeIdSchema.parse((await context.params).connectionId);
    const bodyText = await request.text();
    bodySchema.parse(JSON.parse(bodyText));
    const authorization = await authorizeKubernetesConnector({ request, bodyText, connectionId });
    return NextResponse.json(await kubernetesConnectorRuntime.claim(authorization));
  } catch (error) {
    return errorResponse(error, 401);
  }
}
