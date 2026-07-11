import { waitUntil } from "@vercel/functions";
import { type NextRequest, NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { startDiscordGatewayListener } from "@/lib/bots/discord";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(request: NextRequest) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const result = await startDiscordGatewayListener({
      organizationId,
      origin: request.nextUrl.origin,
      waitUntil,
    });

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "tools",
      action: "discord.gateway.start",
      targetType: "discord-gateway",
      targetId: organizationId,
      message:
        result.status === "already_active"
          ? "Discord gateway listener already active."
          : "Discord gateway listener started.",
      metadata: {
        activeUntil: result.activeUntil,
        webhookUrl: result.webhookUrl,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
