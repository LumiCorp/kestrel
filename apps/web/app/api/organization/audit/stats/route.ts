import { NextResponse } from "next/server";
import { getAdminLogStats } from "@/lib/admin/logs";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const stats = await getAdminLogStats(organizationId);
    return NextResponse.json(stats);
  } catch (error) {
    return errorResponse(error);
  }
}
