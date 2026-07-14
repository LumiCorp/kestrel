import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { disconnectGoogleCalendarFromProject } from "@/lib/integrations/google-calendar-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
    });
    await disconnectGoogleCalendarFromProject({
      organizationId,
      projectId: id,
      userId: session.user.id,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "projects",
      action: "project.google_calendar.disconnected",
      targetType: "project",
      targetId: id,
      message:
        "Disconnected Google Calendar from the Project without revoking the linked Google account.",
      metadata: { oauthAccountPreserved: true },
    });
    return NextResponse.json({ disconnected: true, accountLinked: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
