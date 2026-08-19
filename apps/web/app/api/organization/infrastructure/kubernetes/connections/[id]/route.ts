import { NextResponse } from "next/server";
import { getKubernetesConnection } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json(await getKubernetesConnection({
      organizationId,
      connectionId: routeIdSchema.parse((await context.params).id),
    }));
  } catch (error) { return errorResponse(error, 404); }
}
