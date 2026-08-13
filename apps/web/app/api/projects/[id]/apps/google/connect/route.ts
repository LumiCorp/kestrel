import { NextResponse } from "next/server";
import { googleCalendarConnectionInputSchema } from "@/lib/integrations/google-calendar-contract";
import {
  attachGoogleCalendarConnectionToProject,
  PersonalConnectionRequiredError,
} from "@/lib/integrations/google-calendar-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

export async function POST(
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
    const input = googleCalendarConnectionInputSchema.parse(
      await request.json()
    );
    await attachGoogleCalendarConnectionToProject({
      organizationId,
      projectId: id,
      userId: session.user.id,
      shareAvailability: input.shareAvailability,
    });
    return NextResponse.json({ linked: true, connected: true, url: null });
  } catch (error) {
    if (error instanceof PersonalConnectionRequiredError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          settingsUrl: error.settingsUrl,
        },
        { status: 409 },
      );
    }
    return errorResponse(error, 400);
  }
}
