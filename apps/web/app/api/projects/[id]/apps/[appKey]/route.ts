import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { projectAppEnabledSchema } from "@/lib/apps/contracts";
import { setProjectAppEnabled } from "@/lib/apps/project-service";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; appKey: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id, appKey: encodedAppKey } = await context.params;
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    const appKey = decodeURIComponent(encodedAppKey);
    const input = projectAppEnabledSchema.parse(await request.json());
    const projectApp = await setProjectAppEnabled({
      organizationId,
      projectId: id,
      appKey,
      actorUserId: session.user.id,
      enabled: input.enabled,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "apps",
      action: input.enabled ? "project.app.enabled" : "project.app.disabled",
      targetType: "project",
      targetId: id,
      message: `${input.enabled ? "Enabled" : "Disabled"} ${appKey} for the Project.`,
      metadata: { appKey, enabled: input.enabled },
    });
    return NextResponse.json({ projectApp });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
