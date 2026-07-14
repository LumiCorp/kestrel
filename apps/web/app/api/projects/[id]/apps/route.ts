import { NextResponse } from "next/server";
import { listProjectAppConfigurations } from "@/lib/apps/project-service";
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
    const access = await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json(
      {
        apps: await listProjectAppConfigurations({
          organizationId,
          projectId: id,
          userId: session.user.id,
        }),
        role: access.role,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
