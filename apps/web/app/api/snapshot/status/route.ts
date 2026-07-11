import { NextResponse } from "next/server";
import { getSnapshotStatusForOrganization } from "@/lib/admin/snapshot";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId } = await requireAdminOrganization();
    const status = await getSnapshotStatusForOrganization(organizationId);
    return NextResponse.json(status);
  } catch (error) {
    return errorResponse(error);
  }
}
