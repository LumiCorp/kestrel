import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  AppOperationApprovalError,
  consumeAppOperationApproval,
} from "@/lib/apps/app-operation-approvals";
import { knowledgeDb } from "@/lib/knowledge/db";
import {
  listMicrosoftCalendarEvents,
  listMicrosoftMail,
  listMicrosoftTeamsChats,
  Microsoft365ProviderError,
  searchMicrosoftSharePointSites,
  sendMicrosoftMail,
  sendMicrosoftTeamsChatMessage,
} from "@/lib/integrations/microsoft-365-api";
import {
  capabilityForMicrosoft365Operation,
  microsoft365RuntimeInputSchema,
  type Microsoft365RuntimeInput,
} from "@/lib/integrations/microsoft-365-contract";
import {
  markMicrosoft365ConnectionDegraded,
} from "@/lib/integrations/microsoft-365-oauth";
import {
  HostedPersonalOAuthError,
  resolveHostedPersonalProviderToken,
} from "@/lib/integrations/hosted-personal-oauth";
import {
  authorizeMicrosoft365Capability,
  Microsoft365PolicyError,
} from "@/lib/integrations/microsoft-365-policy";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  let ticket: EnvironmentExecutionTicket | null = null;
  let connectionId: string | null = null;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    if (!ticket.capabilities.includes("kestrel.tools.invoke")) {
      throw new Microsoft365PolicyError("MICROSOFT_365_ROUTE_CAPABILITY_DENIED");
    }
    const input = microsoft365RuntimeInputSchema.parse(await request.json());
    if (input.operation === "sites.search") {
      throw new Microsoft365PolicyError("MICROSOFT_365_CAPABILITY_DENIED");
    }
    if (input.operation === "calendar.list") assertCalendarRange(input);
    const capability = capabilityForMicrosoft365Operation(input.operation);
    const policy = await authorizeMicrosoft365Capability({ ticket, capability });
    connectionId = policy.connection.id;
    const runtimeApprovalId = readApprovalId(
      request.headers.get("x-kestrel-approval-id"),
    );
    if (policy.approvalMode === "ask" && runtimeApprovalId === null) {
      throw new Microsoft365PolicyError("MICROSOFT_365_APPROVAL_REQUIRED", 409);
    }
    if (
      (input.operation === "mail.send" || input.operation === "chat.send") &&
      runtimeApprovalId !== null
    ) {
      const resource = await knowledgeDb.query.appConnectionResources.findFirst({
        where: (table, { and, eq }) => and(
          eq(table.connectionId, policy.connection.id),
          eq(table.resourceType, "account"),
          eq(table.externalId, "primary"),
          eq(table.enabled, true),
        ),
        columns: { id: true },
      });
      if (!resource) {
        throw new Microsoft365PolicyError("MICROSOFT_365_RESOURCE_UNAVAILABLE", 409);
      }
      await consumeAppOperationApproval({
        consumedExecutionId: ticket.runId,
        binding: {
          organizationId: ticket.organizationId,
          environmentId: ticket.environmentId,
          workspaceId: ticket.workspaceId,
          threadId: ticket.threadId,
          actorUserId: ticket.actorId,
          agentId: ticket.agentId,
          appKey: "microsoft_365",
          capabilityKey: capability,
          connectionId: policy.connection.id,
          resourceId: resource.id,
          resourceType: "account",
          operationKey: input.operation,
          runtimeApprovalId,
          payload: input,
        },
      });
    }
    const accessToken = await getAccessToken({
      connectionId: policy.connection.id,
      organizationId: ticket.organizationId,
      operation: input.operation,
      projectId: policy.projectId,
      userId: ticket.actorId,
    });
    const result = await executeOperation(input, accessToken);
    await logAdminEvent({
      organizationId: ticket.organizationId,
      actorUserId: ticket.actorId,
      category: "environment-tools",
      action: `microsoft_365.${input.operation}`,
      targetType: "environment",
      targetId: ticket.environmentId,
      message: `Executed ${input.operation} through Microsoft 365.`,
      metadata: {
        workspaceId: ticket.workspaceId,
        threadId: ticket.threadId,
        runId: ticket.runId,
        agentId: ticket.agentId,
        capability,
        approvalMode: policy.approvalMode,
        ...(runtimeApprovalId === null ? {} : { runtimeApprovalId }),
        loggingMode: policy.loggingMode,
      },
    });
    return NextResponse.json(
      { operation: input.operation, result },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof Microsoft365PolicyError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status }
      );
    }
    if (error instanceof AppOperationApprovalError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: 409 },
      );
    }
    if (error instanceof Microsoft365ProviderError) {
      if (error.reconnectRequired && connectionId) {
        await markMicrosoft365ConnectionDegraded({
          connectionId,
          failureCode: error.code,
        }).catch(() => {});
      }
      return NextResponse.json(
        {
          error: {
            code: error.code,
            reconnectRequired: error.reconnectRequired,
          },
        },
        { status: error.status }
      );
    }
    return errorResponse(error, ticket ? 400 : 401);
  }
}

function readApprovalId(value: string | null) {
  const normalized = value?.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

async function executeOperation(
  input: ReturnType<typeof microsoft365RuntimeInputSchema.parse>,
  accessToken: string
) {
  if (input.operation === "mail.list") {
    return listMicrosoftMail({ accessToken, maxResults: input.maxResults });
  }
  if (input.operation === "mail.send") {
    return sendMicrosoftMail({ accessToken, ...input });
  }
  if (input.operation === "calendar.list") {
    return listMicrosoftCalendarEvents({ accessToken, ...input });
  }
  if (input.operation === "chats.list") {
    return listMicrosoftTeamsChats({ accessToken, ...input });
  }
  if (input.operation === "chat.send") {
    return sendMicrosoftTeamsChatMessage({ accessToken, ...input });
  }
  return searchMicrosoftSharePointSites({ accessToken, ...input });
}

async function getAccessToken(input: {
  connectionId: string;
  organizationId: string;
  operation: Exclude<Microsoft365RuntimeInput["operation"], "sites.search">;
  projectId: string;
  userId: string;
}) {
  try {
    const token = await resolveHostedPersonalProviderToken({
      provider: "microsoft_365",
      connectionId: input.connectionId,
      organizationId: input.organizationId,
      userId: input.userId,
      projectId: input.projectId,
      operation: input.operation,
    });
    return token.accessToken;
  } catch (error) {
    if (error instanceof HostedPersonalOAuthError) {
      if (input.operation === "chat.send" && error.code === "OAUTH_SCOPE_DENIED") {
        throw new Microsoft365ProviderError({
          code: "MICROSOFT_365_TEAMS_SEND_TENANT_CONSENT_REQUIRED",
          status: 403,
        });
      }
      if (error.code === "OAUTH_RECONNECT_REQUIRED") {
        throw new Microsoft365ProviderError({
          code: "MICROSOFT_365_RECONNECT_REQUIRED",
          status: 401,
          reconnectRequired: true,
        });
      }
    }
    throw error;
  }
}

function assertCalendarRange(input: { timeMin: string; timeMax: string }) {
  const start = Date.parse(input.timeMin);
  const end = Date.parse(input.timeMax);
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
    throw new Error("Calendar timeMax must be after timeMin.");
  }
  if (end - start > 31 * 24 * 60 * 60 * 1000) {
    throw new Error("Calendar queries are limited to 31 days.");
  }
}

function readBearer(value: string | null) {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? "");
  if (!match?.[1]) throw new Error("Bearer token is required.");
  return match[1];
}
