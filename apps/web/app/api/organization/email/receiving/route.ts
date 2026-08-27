import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  getPublicReceivingConnection,
  saveReceivingConnection,
} from "@/lib/email/receiving-config";
import {
  getSafeReceivingAdminError,
  parseReceivingAdminJson,
} from "@/lib/email/receiving-admin-error";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const bodySchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  receivingDomainId: z.string().trim().min(1).max(160),
});

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

export async function PUT(request: NextRequest) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const body = bodySchema.parse(await parseReceivingAdminJson(request));
    const connection = await saveReceivingConnection({
      organizationId,
      actorUserId: session.user.id,
      apiKey: body.apiKey,
      receivingDomainId: body.receivingDomainId,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "email",
      action: "update-inbound-receiving",
      targetType: "organization_receiving_connection",
      targetId: organizationId,
      message: "Updated Organization inbound email receiving.",
      metadata: {
        provider: "resend",
        readiness: connection.readiness,
        inboundEnabled: false,
      },
    }).catch(() => {
      console.error(
        "[organization:email:receiving] Configuration committed, but its audit event could not be recorded.",
      );
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  const safe = getSafeReceivingAdminError(error);
  return NextResponse.json(safe.body, { status: safe.status });
}
