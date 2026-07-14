import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { googleCalendarSharingInputSchema } from "@/lib/integrations/google-calendar-contract";
import { setGoogleCalendarAvailabilitySharing } from "@/lib/integrations/google-calendar-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

export async function PATCH(
  request: Request,
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
    const input = googleCalendarSharingInputSchema.parse(await request.json());
    await setGoogleCalendarAvailabilitySharing({
      organizationId,
      projectId: id,
      userId: session.user.id,
      enabled: input.shareAvailability,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "projects",
      action: "project.google_calendar.availability.updated",
      targetType: "project",
      targetId: id,
      message: input.shareAvailability
        ? "Enabled Google Calendar free/busy sharing."
        : "Disabled Google Calendar free/busy sharing.",
      metadata: { shareAvailability: input.shareAvailability },
    });
    return NextResponse.json({
      shareAvailability: input.shareAvailability,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
