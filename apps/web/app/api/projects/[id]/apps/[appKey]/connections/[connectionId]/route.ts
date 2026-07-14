import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { projectAppConnectionAttachmentSchema } from "@/lib/apps/contracts";
import {
  attachProjectAppConnection,
  detachProjectAppConnection,
} from "@/lib/apps/project-service";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { projectRoleAllows, requireProjectRole } from "@/lib/projects/access";

export async function PUT(
  request: Request,
  context: {
    params: Promise<{ id: string; appKey: string; connectionId: string }>;
  }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = await context.params;
    const input = projectAppConnectionAttachmentSchema.parse(
      await request.json()
    );
    const access = await requireProjectRole({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
      minimumRole: input.scope === "shared" ? "editor" : "member",
    });
    const appKey = decodeURIComponent(params.appKey);
    const attachment = await attachProjectAppConnection({
      organizationId,
      projectId: params.id,
      appKey,
      connectionId: params.connectionId,
      actorUserId: session.user.id,
      scope: input.scope,
      isDefault: input.isDefault,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "apps",
      action: "project.app_connection.attached",
      targetType: "project",
      targetId: params.id,
      message: `Attached a ${input.scope} ${appKey} connection to the Project.`,
      metadata: {
        appKey,
        connectionId: params.connectionId,
        scope: input.scope,
        isDefault: input.isDefault,
        role: access.role,
      },
    });
    return NextResponse.json({ attachment });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: Request,
  context: {
    params: Promise<{ id: string; appKey: string; connectionId: string }>;
  }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = await context.params;
    const access = await requireProjectRole({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
    });
    const appKey = decodeURIComponent(params.appKey);
    await detachProjectAppConnection({
      organizationId,
      projectId: params.id,
      appKey,
      connectionId: params.connectionId,
      actorUserId: session.user.id,
      canManageShared: projectRoleAllows(access.role, "editor"),
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "apps",
      action: "project.app_connection.detached",
      targetType: "project",
      targetId: params.id,
      message: `Removed a ${appKey} connection from the Project.`,
      metadata: { appKey, connectionId: params.connectionId },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
