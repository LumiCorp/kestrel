import { KestrelClient, type KestrelRequestContext } from "@kestrel-agents/sdk/runner";
import { NextResponse } from "next/server";
import {
  getKestrelOneHostedAgentId,
  resolveHostedKestrelExecutionProfile,
} from "@/lib/agent/kestrel-runtime";
import { resolveEnvironmentExecutionRoute } from "@/lib/environments/execution-route";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { getThreadAccessForUser } from "@/lib/threads/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let client: KestrelClient | undefined;
  try {
    const { id } = await context.params;
    const { organizationId, session } = await requireActiveOrganization();
    const access = await getThreadAccessForUser(
      id,
      session.user.id,
      organizationId,
    );
    if (!access) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const route = await resolveEnvironmentExecutionRoute({
      organizationId,
      threadId: id,
      actorUserId: session.user.id,
      agentId: getKestrelOneHostedAgentId(),
    });
    client = new KestrelClient({
      target: {
        kind: "remote",
        baseUrl: route.baseUrl,
        authToken: route.authToken,
        ...(route.provider === "desktop" ? { fetchImpl: route.fetchImpl } : {}),
      },
    });
    const requestContext: KestrelRequestContext = {
      tenantId: organizationId,
      actor: {
        actorId: session.user.id,
        actorType: "end_user",
        tenantId: organizationId,
      },
    };
    const resolution = await resolveHostedKestrelExecutionProfile({
      client,
      context: requestContext,
      route: {
        runId: route.runId,
        environmentId: route.environmentId,
        effectiveCapabilities: route.effectiveCapabilities,
        approvalPolicies: route.approvalPolicies,
        reasoningPolicy: route.reasoningPolicy,
      },
      exactToolName: "exec_command",
    });
    return NextResponse.json({
      toolName: "exec_command",
      decision: resolution.exactToolDecisions?.exec_command ?? null,
    });
  } catch (error) {
    return errorResponse(error, 409);
  } finally {
    await client?.close();
  }
}
