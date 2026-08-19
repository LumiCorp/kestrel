import { NextResponse } from "next/server";
import { consumeKubernetesConnectorEnrollment } from "@/lib/environments/kubernetes-connector";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const requestSecret = request.headers.get("x-kestrel-enrollment-secret");
    if (!requestSecret) throw new Error("Connector enrollment secret is required.");
    return NextResponse.json(
      await consumeKubernetesConnectorEnrollment({
        requestId: routeIdSchema.parse((await context.params).id),
        requestSecret,
      }),
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
