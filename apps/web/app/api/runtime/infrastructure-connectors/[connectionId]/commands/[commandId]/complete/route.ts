import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeKubernetesConnector, completeKubernetesConnectorCommand } from "@/lib/environments/kubernetes-connector";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const bodySchema = z.object({ claimToken: z.string().min(32), result: z.unknown(), qualification: z.unknown().optional() }).strict();
export async function POST(request: Request, context: { params: Promise<{ connectionId: string; commandId: string }> }) {
  try {
    const params = await context.params;
    const connectionId = routeIdSchema.parse(params.connectionId);
    const commandId = routeIdSchema.parse(params.commandId);
    const bodyText = await request.text();
    const body = bodySchema.parse(JSON.parse(bodyText));
    const authorization = await authorizeKubernetesConnector({ request, bodyText, connectionId });
    return NextResponse.json(await completeKubernetesConnectorCommand({ authorization, commandId, ...body }));
  } catch (error) { return errorResponse(error, 401); }
}
