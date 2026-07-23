import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";
import {
  createProjectSkill,
  listProjectSkills,
  synchronizeProjectSkills,
} from "@/lib/projects/skills";
import { NextResponse } from "next/server";

const sourceSchema = z.object({
  gitUrl: z.string().trim().min(1).max(2000),
  branch: z.string().trim().min(1).max(255),
  path: z.string().trim().max(1000).optional(),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({ projectId: id, organizationId, userId: session.user.id });
    return NextResponse.json({
      skills: await listProjectSkills({ organizationId, projectId: id }),
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
    const skill = await createProjectSkill({
      organizationId,
      projectId: id,
      actorUserId: session.user.id,
      source: sourceSchema.parse(await request.json()),
    });
    const synchronized = await synchronizeProjectSkills({
      organizationId,
      projectId: id,
      actorUserId: session.user.id,
    });
    return NextResponse.json(
      {
        skill:
          synchronized.skills.find(
            (candidate) => candidate.installationId === skill.installationId
          ) ?? skill,
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
