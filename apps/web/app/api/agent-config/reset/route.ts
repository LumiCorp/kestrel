import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { resetAgentConfigForOrganization } from "@/lib/agent/config";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST() {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const config = await resetAgentConfigForOrganization(organizationId);
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "agent",
      action: "reset-config",
      targetType: "agent_config",
      targetId: config.id,
      message: "Reset agent configuration to defaults.",
    });
    return NextResponse.json(config);
  } catch (error) {
    return errorResponse(error);
  }
}
