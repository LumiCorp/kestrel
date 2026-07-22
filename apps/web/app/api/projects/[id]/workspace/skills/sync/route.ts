import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";
import { synchronizeProjectSkills } from "@/lib/projects/skills";
import { NextResponse } from "next/server";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({ projectId: id, organizationId, userId: session.user.id, minimumRole: "editor" });
    const result = await synchronizeProjectSkills({
      organizationId,
      projectId: id,
      actorUserId: session.user.id,
    });
    return NextResponse.json(
      { skills: result.skills },
      { status: result.deferred ? 202 : 200 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
