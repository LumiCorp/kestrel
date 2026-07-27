import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  describeDesktopConnection,
  listDesktopWorkspaceCatalog,
  revokeDesktopEnvironment,
} from "@/lib/environments/desktop";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const environmentId = routeIdSchema.parse((await context.params).id);
    const connection =
      await knowledgeDb.query.desktopEnvironmentConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, organizationId),
            eq(table.environmentId, environmentId),
          ),
      });
    if (!connection) {
      return NextResponse.json(
        { error: "Desktop Environment connection not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({
      connection: describeDesktopConnection(connection),
      workspaces: await listDesktopWorkspaceCatalog({
        organizationId,
        environmentId,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const environmentId = routeIdSchema.parse((await context.params).id);
    const connection = await revokeDesktopEnvironment({
      organizationId,
      environmentId,
    });
    if (!connection) {
      return NextResponse.json(
        { error: "Active Desktop connection not found." },
        { status: 404 },
      );
    }
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "environments",
      action: "desktop_environment.connection.revoked",
      targetType: "environment",
      targetId: environmentId,
      message: "Revoked Desktop Environment access.",
      metadata: { connectionId: connection.id },
    });
    return NextResponse.json({ revoked: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
