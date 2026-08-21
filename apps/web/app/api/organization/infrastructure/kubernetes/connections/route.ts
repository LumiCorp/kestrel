import { NextResponse } from "next/server";
import { listKubernetesConnections } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json({
      connections: await listKubernetesConnections({ organizationId }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
