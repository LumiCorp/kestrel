import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  GitHubProjectRepositoryError,
  listGitHubProjectRepositories,
  replaceGitHubProjectRepositoryGrants,
} from "@/lib/integrations/github-project-repositories";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

const updateSchema = z.object({
  repositoryIds: z.array(z.string().trim().min(1)).max(500),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId } = await context.params;
    await requireProjectRole({
      projectId,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    return NextResponse.json(
      await listGitHubProjectRepositories({
        organizationId,
        projectId,
        userId: session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof GitHubProjectRepositoryError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 409 },
      );
    }
    return errorResponse(error, 400);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId } = await context.params;
    await requireProjectRole({
      projectId,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    const input = updateSchema.parse(await request.json());
    const result = await replaceGitHubProjectRepositoryGrants({
      organizationId,
      projectId,
      userId: session.user.id,
      repositoryIds: input.repositoryIds,
    });
    const previousIds = new Set(
      result.previousGrants.map((grant) => grant.repositoryId),
    );
    const nextIds = new Set(result.grants.map((grant) => grant.repositoryId));
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "apps",
      action: "project.github_repositories.updated",
      targetType: "project",
      targetId: projectId,
      message: "Updated the Project GitHub repository grants.",
      metadata: {
        added: result.grants.filter(
          (grant) => !previousIds.has(grant.repositoryId),
        ),
        removed: result.previousGrants.filter(
          (grant) => !nextIds.has(grant.repositoryId),
        ),
      },
    });
    return NextResponse.json({ grants: result.grants });
  } catch (error) {
    if (error instanceof GitHubProjectRepositoryError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 409 },
      );
    }
    return errorResponse(error, 400);
  }
}
