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

async function access(context: { params: Promise<{ id: string; installationId: string }> }) {
  const { organizationId, session } = await requireActiveOrganization();
  const { id, installationId } = await context.params;
  await requireProjectRole({ projectId: id, organizationId, userId: session.user.id, minimumRole: "editor" });
  return { organizationId, session, id, installationId: encodeURIComponent(installationId) };
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; installationId: string }> }) {
  try {
    const resolved = await access(context);
    return await proxyProjectWorkspaceSkillRequest({
      organizationId: resolved.organizationId,
      projectId: resolved.id,
      actorUserId: resolved.session.user.id,
      method: "PATCH",
      path: resolved.installationId,
      body: sourceSchema.parse(await request.json()),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; installationId: string }> }) {
  try {
    const resolved = await access(context);
    return await proxyProjectWorkspaceSkillRequest({
      organizationId: resolved.organizationId,
      projectId: resolved.id,
      actorUserId: resolved.session.user.id,
      method: "DELETE",
      path: resolved.installationId,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
