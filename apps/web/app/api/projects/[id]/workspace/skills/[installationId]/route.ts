import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";
import {
  listProjectSkills,
  removeProjectSkill,
  synchronizeProjectSkills,
  updateProjectSkill,
} from "@/lib/projects/skills";
import { NextResponse } from "next/server";

const sourceSchema = z.object({
  gitUrl: z.string().trim().min(1).max(2000),
  branch: z.string().trim().min(1).max(255),
  path: z.string().trim().max(1000).optional(),
});

async function access(context: { params: Promise<{ id: string; installationId: string }> }) {
  const { organizationId, session } = await requireActiveOrganization();
  const { id, installationId } = await context.params;
  await requireProjectRole({ projectId: id, organizationId, userId: session.user.id, minimumRole: "editor" });
  return { organizationId, session, id, installationId };
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; installationId: string }> }) {
  try {
    const resolved = await access(context);
    const skill = await updateProjectSkill({
      organizationId: resolved.organizationId,
      projectId: resolved.id,
      actorUserId: resolved.session.user.id,
      installationId: resolved.installationId,
      source: sourceSchema.parse(await request.json()),
    });
    const synchronized = await synchronizeProjectSkills({
      organizationId: resolved.organizationId,
      projectId: resolved.id,
      actorUserId: resolved.session.user.id,
    });
    return NextResponse.json({
      skill:
        synchronized.skills.find(
          (candidate) => candidate.installationId === skill.installationId
        ) ?? skill,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; installationId: string }> }) {
  try {
    const resolved = await access(context);
    await removeProjectSkill({
      organizationId: resolved.organizationId,
      projectId: resolved.id,
      actorUserId: resolved.session.user.id,
      installationId: resolved.installationId,
    });
    await synchronizeProjectSkills({
      organizationId: resolved.organizationId,
      projectId: resolved.id,
      actorUserId: resolved.session.user.id,
    });
    return NextResponse.json({
      skills: await listProjectSkills({
        organizationId: resolved.organizationId,
        projectId: resolved.id,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
