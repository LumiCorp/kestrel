import { NextResponse } from "next/server";
import { getKubernetesConnectorEnrollment } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json(await getKubernetesConnectorEnrollment({
      requestId: routeIdSchema.parse((await context.params).id),
      organizationId,
    }));
  } catch (error) { return errorResponse(error, 404); }
}
