import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { auth } from "@/lib/auth";
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
  MICROSOFT_365_AUTH_PROVIDER_ID,
  microsoft365RuntimeInputSchema,
} from "@/lib/integrations/microsoft-365-contract";
import {
  markMicrosoft365ConnectionDegraded,
} from "@/lib/integrations/microsoft-365-oauth";
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
    if (input.operation === "calendar.list") assertCalendarRange(input);
    const capability = capabilityForMicrosoft365Operation(input.operation);
    const policy = await authorizeMicrosoft365Capability({ ticket, capability });
    connectionId = policy.connection.id;
    if (
      policy.approvalMode === "ask" &&
      request.headers.get("x-kestrel-runtime-approval") !== "confirmed"
    ) {
      throw new Microsoft365PolicyError("MICROSOFT_365_APPROVAL_REQUIRED", 409);
    }
    const accessToken = await getAccessToken({
      accountId: policy.connection.externalAccountId,
      connectionId: policy.connection.id,
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
  accountId: string | null;
  connectionId: string;
  userId: string;
}) {
  try {
    if (!input.accountId) throw new Error("Microsoft account identity is unavailable.");
    const token = await auth.api.getAccessToken({
      body: {
        providerId: MICROSOFT_365_AUTH_PROVIDER_ID,
        accountId: input.accountId,
        userId: input.userId,
      },
    });
    return token.accessToken;
  } catch {
    await markMicrosoft365ConnectionDegraded({
      connectionId: input.connectionId,
      failureCode: "MICROSOFT_365_RECONNECT_REQUIRED",
    });
    throw new Microsoft365ProviderError({
      code: "MICROSOFT_365_RECONNECT_REQUIRED",
      status: 401,
      reconnectRequired: true,
    });
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
