import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminApiKey, listAdminApiKeys } from "@/lib/admin/api-keys";
import { logAdminEvent } from "@/lib/admin/logs";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  expiresAt: z.string().datetime().optional(),
});

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const keys = await listAdminApiKeys(organizationId);
    return NextResponse.json(keys);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const result = await createAdminApiKey({
      organizationId,
      creatorUserId: session.user.id,
      name: body.name || "Admin key",
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "api-keys",
      action: "create",
      targetType: "admin_api_key",
      targetId: result.key.id,
      message: `Created admin API key ${result.key.name}.`,
      metadata: {
        name: result.key.name,
        expiresAt: result.key.expiresAt,
      },
    });

    return NextResponse.json(
      {
        id: result.key.id,
        name: result.key.name,
        prefix: result.key.prefix,
        start: result.key.start,
        enabled: result.key.enabled,
        expiresAt: result.key.expiresAt,
        createdAt: result.key.createdAt,
        token: result.secret,
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
