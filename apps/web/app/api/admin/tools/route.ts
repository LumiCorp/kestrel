import { type NextRequest, NextResponse } from "next/server";
import { getAdminToolsOverview } from "@/lib/admin/tools";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(request: NextRequest) {
  try {
    const { organizationId } = await requireAdminOrganization();
    const payload = await getAdminToolsOverview(
      organizationId,
      request.nextUrl.origin
    );
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
