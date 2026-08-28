import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  AppOperationApprovalError,
  consumeAppOperationApproval,
} from "@/lib/apps/app-operation-approvals";
import { knowledgeDb } from "@/lib/knowledge/db";
import {
  listMicrosoftCalendarEvents,
  listMicrosoftTeamsChatMessages,
  listMicrosoftMail,
  listMicrosoftTeamsChats,
  Microsoft365ProviderError,
  searchMicrosoftSharePointSites,
  sendMicrosoftMail,
  sendMicrosoftTeamsChatMessage,
} from "@/lib/integrations/microsoft-365-api";
import {
  createMicrosoft365ChatMessagesCursor,
  readMicrosoft365ChatMessagesCursor,
  createMicrosoft365TeamsCursor,
  readMicrosoft365TeamsCursor,
} from "../../../../../../../src/apps/microsoft365Paging.js";
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
import { microsoft365TeamsReadAuditMetadata } from "@/lib/integrations/microsoft-365-teams-read-audit";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  let ticket: EnvironmentExecutionTicket | null = null;
  let connectionId: string | null = null;
  let teamsReadAuditContext:
    | {
        input: Extract<
          ReturnType<typeof microsoft365RuntimeInputSchema.parse>,
          { operation: "chats.list" | "chat.messages.list" }
        >;
        accountId: string;
        projectId: string;
        capability: string;
        loggingMode: string;
      }
    | null = null;
  let teamsSendAuditContext:
    | {
        input: Extract<
          ReturnType<typeof microsoft365RuntimeInputSchema.parse>,
          { operation: "chat.send" }
        >;
        accountId: string | null;
        connectionId: string;
        projectId: string;
        capability: string;
        loggingMode: string;
        runtimeApprovalId: string;
      }
    | null = null;
  const startedAt = Date.now();
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
    if (
      (input.operation === "chats.list" ||
        input.operation === "chat.messages.list") &&
      policy.connection.externalAccountId
    ) {
      teamsReadAuditContext = {
        input,
        accountId: policy.connection.externalAccountId,
        projectId: policy.projectId,
        capability,
        loggingMode: policy.loggingMode,
      };
    }
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
      if (input.operation === "chat.send") {
        teamsSendAuditContext = {
          input,
          accountId: policy.connection.externalAccountId,
          connectionId: policy.connection.id,
          projectId: policy.projectId,
          capability,
          loggingMode: policy.loggingMode,
          runtimeApprovalId,
        };
      }
    }
    const accessToken = await getAccessToken({
      connectionId: policy.connection.id,
      organizationId: ticket.organizationId,
      operation: input.operation,
      projectId: policy.projectId,
      userId: ticket.actorId,
    });
    const result = await executeOperation({
      input,
      accessToken,
      ...(input.operation !== "chats.list" &&
          input.operation !== "chat.messages.list"
        ? {}
        : {
            messageCursorContext: {
              accountId: policy.connection.externalAccountId ?? "",
              projectId: policy.projectId,
            },
          }),
    });
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
        ...teamsReadAuditEventMetadata({
          input,
          result,
          accountId: policy.connection.externalAccountId,
          connectionId: policy.connection.id,
          projectId: policy.projectId,
          startedAt,
        }),
        ...teamsSendAuditMetadata({ input, result }),
      },
    });
    return NextResponse.json(
      { operation: input.operation, result },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    await recordTeamsReadFailure({
      ticket,
      connectionId,
      context: teamsReadAuditContext,
      error,
      startedAt,
    });
    await recordTeamsSendFailure({
      ticket,
      context: teamsSendAuditContext,
      error,
      startedAt,
    });
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
            outcomeUnknown: error.outcomeUnknown,
            ...(error.providerCode === undefined
              ? {}
              : { providerCode: error.providerCode }),
          },
        },
        { status: error.status }
      );
    }
    return errorResponse(error, ticket ? 400 : 401);
  }
}

function teamsReadAuditEventMetadata(input: {
  input: ReturnType<typeof microsoft365RuntimeInputSchema.parse>;
  result: unknown;
  accountId: string | null;
  connectionId: string;
  projectId: string;
  startedAt: number;
}) {
  if (
    input.input.operation !== "chats.list" &&
    input.input.operation !== "chat.messages.list"
  ) {
    return {};
  }
  return {
    accountId: input.accountId,
    connectionId: input.connectionId,
    projectId: input.projectId,
    outcome: "succeeded",
    durationMs: Date.now() - input.startedAt,
    ...microsoft365TeamsReadAuditMetadata({
      input: input.input,
      result: input.result,
    }),
  };
}

async function recordTeamsReadFailure(input: {
  ticket: EnvironmentExecutionTicket | null;
  connectionId: string | null;
  context: {
    input: Extract<
      ReturnType<typeof microsoft365RuntimeInputSchema.parse>,
      { operation: "chats.list" | "chat.messages.list" }
    >;
    accountId: string;
    projectId: string;
    capability: string;
    loggingMode: string;
  } | null;
  error: unknown;
  startedAt: number;
}) {
  if (!input.ticket || !input.connectionId || !input.context) return;
  const failureCode =
    input.error instanceof Microsoft365PolicyError ||
    input.error instanceof Microsoft365ProviderError ||
    input.error instanceof AppOperationApprovalError
      ? input.error.code
      : "MICROSOFT_365_REQUEST_FAILED";
  await logAdminEvent({
    organizationId: input.ticket.organizationId,
    actorUserId: input.ticket.actorId,
    category: "environment-tools",
    action: `microsoft_365.${input.context.input.operation}`,
    targetType: "environment",
    targetId: input.ticket.environmentId,
    message: `Microsoft 365 ${input.context.input.operation} failed.`,
    metadata: {
      workspaceId: input.ticket.workspaceId,
      threadId: input.ticket.threadId,
      runId: input.ticket.runId,
      agentId: input.ticket.agentId,
      capability: input.context.capability,
      loggingMode: input.context.loggingMode,
      accountId: input.context.accountId,
      connectionId: input.connectionId,
      projectId: input.context.projectId,
      outcome: "failed",
      failureCode,
      durationMs: Date.now() - input.startedAt,
      ...microsoft365TeamsReadAuditMetadata({ input: input.context.input }),
    },
  }).catch(() => {});
}

async function recordTeamsSendFailure(input: {
  ticket: EnvironmentExecutionTicket | null;
  context: {
    input: Extract<
      ReturnType<typeof microsoft365RuntimeInputSchema.parse>,
      { operation: "chat.send" }
    >;
    accountId: string | null;
    connectionId: string;
    projectId: string;
    capability: string;
    loggingMode: string;
    runtimeApprovalId: string;
  } | null;
  error: unknown;
  startedAt: number;
}) {
  if (!input.ticket || !input.context || !(input.error instanceof Microsoft365ProviderError)) {
    return;
  }
  await logAdminEvent({
    organizationId: input.ticket.organizationId,
    actorUserId: input.ticket.actorId,
    category: "environment-tools",
    action: "microsoft_365.chat.send",
    targetType: "environment",
    targetId: input.ticket.environmentId,
    message: "Microsoft 365 chat.send failed.",
    metadata: {
      workspaceId: input.ticket.workspaceId,
      threadId: input.ticket.threadId,
      runId: input.ticket.runId,
      agentId: input.ticket.agentId,
      capability: input.context.capability,
      loggingMode: input.context.loggingMode,
      accountId: input.context.accountId,
      connectionId: input.context.connectionId,
      projectId: input.context.projectId,
      runtimeApprovalId: input.context.runtimeApprovalId,
      durationMs: Date.now() - input.startedAt,
      providerStatus: input.error.status,
      ...teamsSendAuditMetadata({
        input: input.context.input,
        result: { status: "FAILED", errorCode: input.error.code },
        mutationOutcome: input.error.outcomeUnknown ? "outcome_unknown" : "rejected",
        providerErrorCode: input.error.providerCode ?? input.error.code,
      }),
    },
  }).catch(() => {});
}

function teamsSendAuditMetadata(input: {
  input: ReturnType<typeof microsoft365RuntimeInputSchema.parse>;
  result: unknown;
  mutationOutcome?: "confirmed" | "rejected" | "outcome_unknown";
  providerErrorCode?: string;
}) {
  if (input.input.operation !== "chat.send") return {};
  const result = input.result as { id?: unknown; createdAt?: unknown };
  return {
    chatId: input.input.chatId,
    contentBytes: Buffer.byteLength(input.input.content, "utf8"),
    contentHash: createHash("sha256").update(input.input.content).digest("hex"),
    mutationOutcome: input.mutationOutcome ?? "confirmed",
    ...(input.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: input.providerErrorCode }),
    ...(typeof result.id === "string" ? { providerMessageId: result.id } : {}),
    ...(typeof result.createdAt === "string"
      ? { providerCreatedAt: result.createdAt }
      : {}),
  };
}

function readApprovalId(value: string | null) {
  const normalized = value?.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

async function executeOperation(input: {
  input: ReturnType<typeof microsoft365RuntimeInputSchema.parse>;
  accessToken: string;
  messageCursorContext?: { accountId: string; projectId: string };
}) {
  if (input.input.operation === "mail.list") {
    return listMicrosoftMail({ accessToken: input.accessToken, maxResults: input.input.maxResults });
  }
  if (input.input.operation === "mail.send") {
    return sendMicrosoftMail({ accessToken: input.accessToken, ...input.input });
  }
  if (input.input.operation === "calendar.list") {
    return listMicrosoftCalendarEvents({ accessToken: input.accessToken, ...input.input });
  }
  if (input.input.operation === "chats.list") {
    const context = input.messageCursorContext;
    if (!context?.accountId) {
      throw new Microsoft365PolicyError("MICROSOFT_365_ACCOUNT_DENIED");
    }
    const cursorContext = {
      ...context,
      operation: "chats.list" as const,
      maxResults: input.input.maxResults,
    };
    const nextLink = input.input.cursor === undefined
      ? undefined
      : readMicrosoft365TeamsCursor({
          secret: microsoft365CursorSecret(),
          cursor: input.input.cursor,
          context: cursorContext,
        }).nextLink;
    const result = await listMicrosoftTeamsChats({
      accessToken: input.accessToken,
      maxResults: input.input.maxResults,
      ...(nextLink === undefined ? {} : { nextLink }),
    });
    return {
      items: result.items,
      nextCursor:
        result.nextPage === null
          ? null
          : createMicrosoft365TeamsCursor({
              secret: microsoft365CursorSecret(),
              context: cursorContext,
              nextLink: result.nextPage,
            }),
    };
  }
  if (input.input.operation === "chat.messages.list") {
    const context = input.messageCursorContext;
    if (!context?.accountId) {
      throw new Microsoft365PolicyError("MICROSOFT_365_ACCOUNT_DENIED");
    }
    const cursorContext = {
      ...context,
      chatId: input.input.chatId,
      maxResults: input.input.maxResults,
    };
    const nextLink = input.input.cursor === undefined
      ? undefined
      : readMicrosoft365ChatMessagesCursor({
          secret: microsoft365CursorSecret(),
          cursor: input.input.cursor,
          context: cursorContext,
        }).nextLink;
    const result = await listMicrosoftTeamsChatMessages({
      accessToken: input.accessToken,
      chatId: input.input.chatId,
      maxResults: input.input.maxResults,
      ...(nextLink === undefined ? {} : { nextLink }),
    });
    return {
      items: result.items,
      nextCursor:
        result.nextPage === null
          ? null
          : createMicrosoft365ChatMessagesCursor({
              secret: microsoft365CursorSecret(),
              context: cursorContext,
              nextLink: result.nextPage,
            }),
    };
  }
  if (input.input.operation === "chat.send") {
    return sendMicrosoftTeamsChatMessage({ accessToken: input.accessToken, ...input.input });
  }
  return searchMicrosoftSharePointSites({ accessToken: input.accessToken, ...input.input });
}

function microsoft365CursorSecret() {
  const secret = process.env.KESTREL_MICROSOFT_365_CURSOR_SECRET;
  if (!secret || secret.length < 32) {
    throw new Microsoft365PolicyError("MICROSOFT_365_CURSOR_UNAVAILABLE", 503);
  }
  return secret;
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
