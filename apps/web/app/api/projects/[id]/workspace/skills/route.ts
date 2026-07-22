import { z } from "zod";
import { proxyProjectWorkspaceSkillRequest } from "@/lib/environments/workspace-skills";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

const sourceSchema = z.object({
  gitUrl: z.string().url().max(2_000),
  branch: z.string().trim().min(1).max(255),
  path: z.string().trim().max(1_000).optional(),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({ projectId: id, organizationId, userId: session.user.id });
    return await proxyProjectWorkspaceSkillRequest({
      organizationId,
      projectId: id,
      actorUserId: session.user.id,
      method: "GET",
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({ projectId: id, organizationId, userId: session.user.id, minimumRole: "editor" });
    return await proxyProjectWorkspaceSkillRequest({
      organizationId,
      projectId: id,
      actorUserId: session.user.id,
      method: "POST",
      body: sourceSchema.parse(await request.json()),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
