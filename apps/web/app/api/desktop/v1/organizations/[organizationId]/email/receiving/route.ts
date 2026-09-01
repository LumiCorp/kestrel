import { NextResponse } from "next/server";
import { getPublicReceivingConnection } from "@/lib/email/receiving-config";
import { getSafeReceivingAdminError } from "@/lib/email/receiving-admin-error";
import { createDesktopReceivingPutHandler } from "@/lib/email/receiving-admin-route-handlers";
import {
  requireDesktopReceivingAdmin,
  requireDesktopReceivingMember,
} from "@/lib/email/desktop-receiving-auth";
import { routeIdSchema } from "@/lib/knowledge/validation";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const organizationId = routeIdSchema.parse(
      (await context.params).organizationId,
    );
    await requireDesktopReceivingMember(request, organizationId);
    return NextResponse.json(
      { connection: await getPublicReceivingConnection(organizationId) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const PUT = createDesktopReceivingPutHandler({
  requireAdmin: requireDesktopReceivingAdmin,
});

function errorResponse(error: unknown) {
  const safe = getSafeReceivingAdminError(error);
  return NextResponse.json(safe.body, { status: safe.status });
}
