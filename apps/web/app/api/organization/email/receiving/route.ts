import { NextResponse } from "next/server";
import { getPublicReceivingConnection } from "@/lib/email/receiving-config";
import { getSafeReceivingAdminError } from "@/lib/email/receiving-admin-error";
import { createOneReceivingPutHandler } from "@/lib/email/receiving-admin-route-handlers";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json(
      { connection: await getPublicReceivingConnection(organizationId) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const PUT = createOneReceivingPutHandler({
  requireAdmin: requireOrganizationAdmin,
});

function errorResponse(error: unknown) {
  const safe = getSafeReceivingAdminError(error);
  return NextResponse.json(safe.body, { status: safe.status });
}
