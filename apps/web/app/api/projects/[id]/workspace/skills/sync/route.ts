import { proxyProjectWorkspaceSkillRequest } from "@/lib/environments/workspace-skills";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({ projectId: id, organizationId, userId: session.user.id, minimumRole: "editor" });
    return await proxyProjectWorkspaceSkillRequest({
      organizationId,
      projectId: id,
      actorUserId: session.user.id,
      method: "POST",
      path: "sync",
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
