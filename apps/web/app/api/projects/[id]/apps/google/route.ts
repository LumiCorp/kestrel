import { NextResponse } from "next/server";
import { getGoogleCalendarProjectStatus } from "@/lib/integrations/google-calendar-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

export async function GET(
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
    return NextResponse.json(
      await getGoogleCalendarProjectStatus({
        organizationId,
        projectId: id,
        userId: session.user.id,
      }),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
