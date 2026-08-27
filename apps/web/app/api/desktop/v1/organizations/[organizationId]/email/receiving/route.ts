import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getPublicReceivingConnection,
  saveReceivingConnection,
} from "@/lib/email/receiving-config";
import {
  getSafeReceivingAdminError,
  parseReceivingAdminJson,
} from "@/lib/email/receiving-admin-error";
import {
  requireDesktopReceivingAdmin,
  requireDesktopReceivingMember,
} from "@/lib/email/desktop-receiving-auth";
import { routeIdSchema } from "@/lib/knowledge/validation";

const bodySchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  receivingDomainId: z.string().trim().min(1).max(160),
});

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

export async function PUT(request: Request, context: Context) {
  try {
    const organizationId = routeIdSchema.parse(
      (await context.params).organizationId,
    );
    const user = await requireDesktopReceivingAdmin(request, organizationId);
    const body = bodySchema.parse(await parseReceivingAdminJson(request));
    return NextResponse.json({
      connection: await saveReceivingConnection({
        organizationId,
        actorUserId: user.id,
        apiKey: body.apiKey,
        receivingDomainId: body.receivingDomainId,
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  const safe = getSafeReceivingAdminError(error);
  return NextResponse.json(safe.body, { status: safe.status });
}
