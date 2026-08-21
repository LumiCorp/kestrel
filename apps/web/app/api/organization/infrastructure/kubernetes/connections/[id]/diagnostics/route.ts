import { NextResponse } from "next/server";
import { getKubernetesConnectionDiagnostic } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const connectionId = routeIdSchema.parse((await context.params).id);
    const diagnostic = await getKubernetesConnectionDiagnostic({
      organizationId,
      connectionId,
    });
    return new NextResponse(JSON.stringify(diagnostic, null, 2), {
      headers: {
        "content-disposition": `attachment; filename="kubernetes-byoc-${connectionId}.json"`,
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}
