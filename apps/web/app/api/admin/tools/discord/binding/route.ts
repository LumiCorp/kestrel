import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveAdminDiscordBinding } from "@/lib/admin/tools";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const updateDiscordBindingSchema = z.object({
  guildId: z.string().regex(/^\d{16,20}$/, "Invalid Discord guild ID"),
  guildName: z.string().trim().max(100).optional().nullable(),
  enabled: z.boolean().default(true),
});

export async function PUT(request: NextRequest) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const body = updateDiscordBindingSchema.parse(await request.json());

    const binding = await saveAdminDiscordBinding({
      actorUserId: session.user.id,
      enabled: body.enabled,
      guildId: body.guildId,
      guildName: body.guildName ?? null,
      organizationId,
    });

    return NextResponse.json(binding);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
