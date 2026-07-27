import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { approveDesktopEnrollment } from "@/lib/environments/desktop";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const id = routeIdSchema.parse((await context.params).id);
    const approved = await approveDesktopEnrollment({
      requestId: id,
      organizationId,
      actorUserId: session.user.id,
      approval: await request.json().catch(() => ({})),
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "environments",
      action: "desktop_environment.enrollment.approved",
      targetType: "environment",
      targetId: approved.environment.id,
      message: `Approved Desktop Environment ${approved.environment.name}.`,
      metadata: {
        connectionId: approved.connection.id,
        fingerprint: approved.fingerprint,
      },
    });
    return NextResponse.json(approved, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
