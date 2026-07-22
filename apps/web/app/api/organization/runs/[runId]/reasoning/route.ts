import { NextResponse } from "next/server";
import { readKestrelOneRetainedReasoning } from "@/lib/agent/kestrel-runtime";
import { logAdminEvent } from "@/lib/admin/logs";
import { createEnvironmentMachineRoute } from "@/lib/environments/execution-route";
import { knowledgeDb } from "@/lib/knowledge/db";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return handleReasoningRequest(context, "read");
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return handleReasoningRequest(context, "delete");
}

async function handleReasoningRequest(
  context: { params: Promise<{ runId: string }> },
  action: "read" | "delete",
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { runId } = await context.params;
    const execution = await knowledgeDb.query.environmentRunExecutions.findFirst({
      where: (table, { and, eq }) => and(
        eq(table.id, runId),
        eq(table.organizationId, organizationId),
      ),
    });
    if (!execution?.runtimeRunId) {
      return NextResponse.json({ error: "Retained reasoning is unavailable for this run." }, { status: 404 });
    }
    if (!execution.reasoningKeyReady) {
      return NextResponse.json(
        { error: "This run did not advertise encrypted reasoning retention readiness." },
        { status: 409 },
      );
    }
    if (execution.reasoningPolicySnapshot?.retention.mode !== "provider_visible") {
      return NextResponse.json({ error: "This run used live-only reasoning." }, { status: 404 });
    }
    const [environment, workspace] = await Promise.all([
      knowledgeDb.query.environments.findFirst({
        where: (table, { and, eq }) => and(
          eq(table.id, execution.environmentId),
          eq(table.organizationId, organizationId),
        ),
      }),
      knowledgeDb.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq }) => and(
          eq(table.id, execution.workspaceId),
          eq(table.organizationId, organizationId),
        ),
      }),
    ]);
    if (!((environment?.routerUrl && environment.flyAppName ) && workspace?.flyMachineId)) {
      return NextResponse.json({ error: "Environment runtime is unavailable." }, { status: 409 });
    }
    if (environment.reasoningRetentionMode !== "provider_visible") {
      return NextResponse.json(
        { error: "Provider-visible reasoning retention is currently disabled for this Environment." },
        { status: 404 },
      );
    }
    const reasoningPolicy = {
      request: {
        mode: environment.reasoningRequestMode,
        ...(environment.reasoningEffort ? { effort: environment.reasoningEffort } : {}),
      },
      retention: {
        mode: environment.reasoningRetentionMode,
        days: environment.reasoningRetentionDays,
      },
    } as const;
    const route = createEnvironmentMachineRoute({
      organizationId,
      environmentId: environment.id,
      workspaceId: workspace.id,
      threadId: execution.threadId,
      actorId: session.user.id,
      flyAppName: environment.flyAppName,
      flyMachineId: workspace.flyMachineId,
      routerUrl: environment.routerUrl,
      capabilities: [action === "read" ? "reasoning.read" : "reasoning.delete"],
    });
    const payload = await readKestrelOneRetainedReasoning({
      baseUrl: route.baseUrl,
      authToken: route.authToken,
      organizationId,
      actorUserId: session.user.id,
      runtimeRunId: execution.runtimeRunId,
      sessionId: execution.threadId,
      reasoningPolicy,
      action,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "environments",
      action: `environment.reasoning_retention.${action}`,
      targetType: "environment_run_execution",
      targetId: execution.id,
      message: `${action === "read" ? "Read" : "Deleted"} retained provider-visible reasoning for a run.`,
      metadata: { runtimeRunId: execution.runtimeRunId },
    });
    return NextResponse.json(payload, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
