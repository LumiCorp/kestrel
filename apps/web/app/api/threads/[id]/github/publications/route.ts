import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAppOperationApprovalRequest } from "@/lib/apps/app-operation-approvals";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import {
  resolveEnvironmentExecutionRoute,
  resolveEnvironmentPublicationRoute,
} from "@/lib/environments/execution-route";
import {
  GitHubProjectRepositoryError,
  listGitHubProjectRepositories,
} from "@/lib/integrations/github-project-repositories";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { getThreadAccessForUser } from "@/lib/threads/store";

const publicationSchema = z.object({
  promotionId: z.string().trim().min(1).max(512),
  candidateFingerprint: z.string().trim().min(1).max(512),
  repositoryId: z.string().trim().min(1).max(128),
  mode: z.enum(["agent_branch", "initialize"]),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: threadId } = await context.params;
    const access = await getThreadAccessForUser(
      threadId,
      session.user.id,
      organizationId,
    );
    if (!access?.thread.projectId) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const binding = await knowledgeDb.query.threadExecutionBindings.findFirst({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.organizationId, organizationId),
          operators.eq(table.threadId, threadId),
        ),
      columns: { workspaceId: true },
    });
    const result = await listGitHubProjectRepositories({
      organizationId,
      projectId: access.thread.projectId,
      userId: session.user.id,
      workspaceId: binding?.workspaceId ?? null,
    });
    return NextResponse.json({
      repositories: result.repositories.filter(
        (repository) => repository.source || repository.granted,
      ),
    });
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: threadId } = await context.params;
    const input = publicationSchema.parse(await request.json());
    const access = await getThreadAccessForUser(
      threadId,
      session.user.id,
      organizationId,
    );
    const projectId = access?.thread.projectId;
    if (!projectId) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const binding = await knowledgeDb.query.threadExecutionBindings.findFirst({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.organizationId, organizationId),
          operators.eq(table.threadId, threadId),
        ),
      columns: { workspaceId: true },
    });
    const repositories = await listGitHubProjectRepositories({
      organizationId,
      projectId,
      userId: session.user.id,
      workspaceId: binding?.workspaceId ?? null,
    });
    const repository = repositories.repositories.find(
      (candidate) => candidate.repositoryId === input.repositoryId,
    );
    if (!repository) {
      return NextResponse.json(
        { error: { code: "GITHUB_REPOSITORY_NOT_SYNCED" } },
        { status: 409 },
      );
    }
    if (!(repository.source || repository.granted)) {
      return NextResponse.json(
        { error: { code: "GITHUB_REPOSITORY_NOT_GRANTED" } },
        { status: 403 },
      );
    }
    if (!repository.canPush) {
      return NextResponse.json(
        { error: { code: "GITHUB_REPOSITORY_PUSH_DENIED" } },
        { status: 403 },
      );
    }
    if (repository.isEmpty === null) {
      return NextResponse.json(
        { error: { code: "GITHUB_REPOSITORY_NOT_SYNCED" } },
        { status: 409 },
      );
    }
    if (input.mode === "initialize" && !repository.isEmpty) {
      return NextResponse.json(
        { error: { code: "GITHUB_REPOSITORY_NOT_EMPTY" } },
        { status: 409 },
      );
    }
    if (input.mode === "agent_branch" && repository.isEmpty) {
      return NextResponse.json(
        { error: { code: "GITHUB_REPOSITORY_INITIALIZATION_REQUIRED" } },
        { status: 409 },
      );
    }
    const inspectionRoute = await resolveEnvironmentExecutionRoute({
      organizationId,
      threadId,
      actorUserId: session.user.id,
      agentId: "kestrel-one-ui",
    });
    const inspectionResponse = await fetch(
      new URL(
        `/v1/promotions/${encodeURIComponent(input.promotionId)}`,
        inspectionRoute.baseUrl,
      ),
      {
        headers: { authorization: `Bearer ${inspectionRoute.authToken}` },
        cache: "no-store",
      },
    );
    const inspected = (await inspectionResponse.json()) as {
      preview?: {
        status?: string;
        candidateFingerprint?: string;
        promotion?: { runId?: string };
      };
    };
    const promotionRunId = inspected.preview?.promotion?.runId;
    if (
      !inspectionResponse.ok ||
      inspected.preview?.status !== "ready" ||
      inspected.preview.candidateFingerprint !== input.candidateFingerprint ||
      !promotionRunId
    ) {
      return NextResponse.json(
        { error: { code: "GITHUB_PUSH_CANDIDATE_CHANGED" } },
        { status: 409 },
      );
    }
    const execution = await knowledgeDb.query.environmentRunExecutions.findFirst({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.id, promotionRunId),
          operators.eq(table.organizationId, organizationId),
          operators.eq(table.threadId, threadId),
          operators.eq(table.actorId, session.user.id),
          operators.eq(table.status, "completed"),
        ),
    });
    if (!execution) {
      return NextResponse.json(
        { error: { code: "GITHUB_PUSH_CANDIDATE_CHANGED" } },
        { status: 409 },
      );
    }
    const route = await resolveEnvironmentPublicationRoute({
      organizationId,
      executionId: execution.id,
    });
    if (!route || route.threadId !== threadId) {
      return NextResponse.json(
        { error: { code: "GITHUB_PUSH_CANDIDATE_CHANGED" } },
        { status: 409 },
      );
    }
    const previewResponse = await fetch(
      new URL(
        `/v1/promotions/${encodeURIComponent(input.promotionId)}`,
        route.baseUrl,
      ),
      {
        headers: { authorization: `Bearer ${route.authToken}` },
        cache: "no-store",
      },
    );
    const previewPayload = (await previewResponse.json()) as {
      preview?: {
        status?: string;
        candidateFingerprint?: string;
        promotion?: { runId?: string };
      };
    };
    if (
      !previewResponse.ok ||
      previewPayload.preview?.status !== "ready" ||
      previewPayload.preview.candidateFingerprint !== input.candidateFingerprint ||
      previewPayload.preview.promotion?.runId !== execution.id
    ) {
      return NextResponse.json(
        { error: { code: "GITHUB_PUSH_CANDIDATE_CHANGED" } },
        { status: 409 },
      );
    }
    let approvalId: string | undefined;
    if (input.mode === "initialize") {
      const appAccess = await resolveEffectiveProjectAppAccess({
        organizationId,
        projectId,
        appKey: "github",
        userId: session.user.id,
        includePolicyOnly: true,
      });
      if (!appAccess?.connectionId) {
        return NextResponse.json(
          { error: { code: "GITHUB_CONNECTION_UNAVAILABLE" } },
          { status: 409 },
        );
      }
      approvalId = crypto.randomUUID();
      await recordAppOperationApprovalRequest({
        projectId,
        requestedExecutionId: execution.id,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        approvedByUserId: session.user.id,
        binding: {
          organizationId,
          environmentId: execution.environmentId,
          workspaceId: execution.workspaceId,
          threadId,
          actorUserId: session.user.id,
          agentId: "kestrel-one-turn-worker",
          appKey: "github",
          capabilityKey: "repository.initialize",
          connectionId: appAccess.connectionId,
          resourceId: repository.resourceId,
          resourceType: "repository",
          operationKey: "repository.initialize",
          runtimeApprovalId: approvalId,
          payload: {
            repository: repository.fullName,
            candidateFingerprint: input.candidateFingerprint,
            branch: "main",
          },
        },
      });
    }
    const publicationResponse = await fetch(
      new URL("/v1/git/publish-candidate", route.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${route.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...input,
          resourceId: repository.resourceId,
          ...(approvalId ? { approvalId } : {}),
        }),
      },
    );
    return new NextResponse(await publicationResponse.arrayBuffer(), {
      status: publicationResponse.status,
      headers: { "content-type": "application/json" },
    });
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
