import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  AppOperationApprovalError,
  consumeAppOperationApproval,
} from "@/lib/apps/app-operation-approvals";
import { knowledgeDb } from "@/lib/knowledge/db";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  GoogleCalendarProviderError,
  listGoogleCalendarEvents,
  queryGoogleCalendarFreeBusy,
  updateGoogleCalendarEvent,
} from "@/lib/integrations/google-calendar-api";
import {
  createGoogleCalendarPageCursor,
  readGoogleCalendarPageCursor,
} from "../../../../../../../src/apps/googleCalendarPaging.js";
import {
  assertGoogleCalendarRange,
  capabilityForGoogleCalendarOperation,
  googleCalendarRuntimeInputSchema,
} from "@/lib/integrations/google-calendar-contract";
import {
  HostedPersonalOAuthError,
  markHostedPersonalAuthorizationDegraded,
  resolveHostedPersonalProviderToken,
} from "@/lib/integrations/hosted-personal-oauth";
import {
  authorizeGoogleCalendarAvailabilitySubjects,
  authorizeGoogleCalendarCapability,
  GoogleCalendarPolicyError,
  listGoogleCalendarAvailabilitySubjects,
} from "@/lib/integrations/google-calendar-policy";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  let ticket: EnvironmentExecutionTicket | null = null;
  const connectionIdsUsed = new Set<string>();
  let mutationAuditContext:
    | {
        input: Extract<
          z.infer<typeof googleCalendarRuntimeInputSchema>,
          { operation: "events.create" | "events.update" | "events.delete" }
        >;
        connectionId: string;
        accountId: string | null;
        projectId: string;
        capability: string;
        loggingMode: string;
        runtimeApprovalId: string;
      }
    | null = null;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    if (!ticket.capabilities.includes("kestrel.tools.invoke")) {
      throw new GoogleCalendarPolicyError(
        "GOOGLE_CALENDAR_ROUTE_CAPABILITY_DENIED"
      );
    }
    const input = googleCalendarRuntimeInputSchema.parse(await request.json());
    if ("timeMin" in input) assertGoogleCalendarRange(input);
    const capability = capabilityForGoogleCalendarOperation(input.operation);
    const policy = await authorizeGoogleCalendarCapability({
      ticket,
      capability,
      requireRunExecution: true,
    });
    const runtimeApprovalId = readApprovalId(
      request.headers.get("x-kestrel-approval-id"),
    );
    if (policy.approvalMode === "ask" && runtimeApprovalId === null) {
      throw new GoogleCalendarPolicyError(
        "GOOGLE_CALENDAR_APPROVAL_REQUIRED",
        409
      );
    }
    if (
      input.operation !== "availability.subjects" &&
      input.operation !== "availability.query" &&
      runtimeApprovalId !== null
    ) {
      const resource = await knowledgeDb.query.appConnectionResources.findFirst({
        where: (table, { and, eq }) => and(
          eq(table.connectionId, policy.connection.id),
          eq(table.resourceType, "calendar"),
          eq(table.externalId, "primary"),
          eq(table.enabled, true),
        ),
        columns: { id: true },
      });
      if (!resource) {
        throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_RESOURCE_UNAVAILABLE", 409);
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
          appKey: "google_workspace",
          capabilityKey: capability,
          connectionId: policy.connection.id,
          resourceId: resource.id,
          resourceType: "calendar",
          operationKey: input.operation,
          runtimeApprovalId,
          payload: input,
        },
      });
      if (
        input.operation === "events.create" ||
        input.operation === "events.update" ||
        input.operation === "events.delete"
      ) {
        mutationAuditContext = {
          input,
          connectionId: policy.connection.id,
          accountId: policy.connection.externalAccountId,
          projectId: policy.projectId,
          capability,
          loggingMode: policy.loggingMode,
          runtimeApprovalId,
        };
      }
    }

    let result: unknown;
    let subjectCount = 0;
    if (input.operation === "availability.subjects") {
      const subjects = await listGoogleCalendarAvailabilitySubjects({
        projectId: policy.projectId,
        organizationId: ticket.organizationId,
        actorUserId: ticket.actorId,
      });
      subjectCount = subjects.length;
      result = {
        subjects: subjects.map((subject) => ({
          subjectId: subject.subjectId,
          displayName: subject.displayName,
          sharing: "free_busy",
        })),
      };
    } else if (input.operation === "availability.query") {
      const subjects = await authorizeGoogleCalendarAvailabilitySubjects({
        ticket,
        subjectIds: input.subjectIds,
        projectId: policy.projectId,
      });
      subjectCount = subjects.length;
      for (const subject of subjects) {
        connectionIdsUsed.add(subject.connectionId);
      }
      result = {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        subjects: await Promise.all(
          subjects.map(async (subject) => ({
            subjectId: subject.subjectId,
            displayName: subject.displayName,
            busy: await queryGoogleCalendarFreeBusy({
              accessToken: await getConnectionAccessToken({
                connectionId: subject.connectionId,
                userId: subject.userId,
                organizationId: ticket!.organizationId,
                projectId: policy.projectId,
                operation: "availability.query",
              }),
              timeMin: input.timeMin,
              timeMax: input.timeMax,
            }),
          }))
        ),
      };
    } else {
      const accessToken = await getConnectionAccessToken({
        connectionId: policy.connection.id,
        userId: ticket.actorId,
        organizationId: ticket.organizationId,
        projectId: policy.projectId,
        operation: input.operation,
      });
      connectionIdsUsed.add(policy.connection.id);
      if (input.operation === "events.list") {
        if (!policy.connection.externalAccountId) {
          throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_ACCOUNT_DENIED");
        }
        const cursorContext = {
          accountId: policy.connection.externalAccountId,
          projectId: policy.projectId,
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          maxResults: input.maxResults,
        };
        const pageToken = input.cursor === undefined
          ? undefined
          : readGoogleCalendarPageCursor({
              secret: googleCalendarCursorSecret(),
              cursor: input.cursor,
              context: cursorContext,
            }).pageToken;
        const page = await listGoogleCalendarEvents({
          accessToken,
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          maxResults: input.maxResults,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        result = {
          events: page.events,
          nextCursor: page.nextPageToken === null
            ? null
            : createGoogleCalendarPageCursor({
                secret: googleCalendarCursorSecret(),
                context: cursorContext,
                pageToken: page.nextPageToken,
              }),
        };
      } else if (input.operation === "events.create") {
        result = await createGoogleCalendarEvent({
          accessToken,
          event: input.event,
          notifyAttendees: input.notifyAttendees,
        });
      } else if (input.operation === "events.update") {
        result = await updateGoogleCalendarEvent({
          accessToken,
          eventId: input.eventId,
          patch: input.patch,
          notifyAttendees: input.notifyAttendees,
        });
      } else {
        result = await deleteGoogleCalendarEvent({
          accessToken,
          eventId: input.eventId,
          notifyAttendees: input.notifyAttendees,
        });
      }
    }
    await logAdminEvent({
      organizationId: ticket.organizationId,
      actorUserId: ticket.actorId,
      category: "environment-tools",
      action: `google_calendar.${input.operation}`,
      targetType: "environment",
      targetId: ticket.environmentId,
      message: `Executed ${input.operation} through Google Calendar.`,
      metadata: {
        workspaceId: ticket.workspaceId,
        threadId: ticket.threadId,
        runId: ticket.runId,
        agentId: ticket.agentId,
        capability,
        approvalMode: policy.approvalMode,
        ...(runtimeApprovalId === null ? {} : { runtimeApprovalId }),
        loggingMode: policy.loggingMode,
        subjectCount,
        ...googleCalendarMutationAuditMetadata({ input, result }),
      },
    });
    return NextResponse.json(
      { operation: input.operation, result },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GoogleCalendarPolicyError) {
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
    if (error instanceof GoogleCalendarProviderError) {
      await recordGoogleCalendarMutationFailure({
        ticket,
        context: mutationAuditContext,
        error,
      });
      if (error.reconnectRequired) {
        await Promise.all(
          [...connectionIdsUsed].map((connectionId) =>
            markHostedPersonalAuthorizationDegraded({
              connectionId,
              code: error.code,
            })
          )
        ).catch(() => {});
      }
      return NextResponse.json(
        {
          error: {
            code: error.code,
            reconnectRequired: error.reconnectRequired,
            outcomeUnknown: error.outcomeUnknown,
          },
        },
        { status: error.status }
      );
    }
    return errorResponse(error, ticket ? 400 : 401);
  }
}

function googleCalendarMutationAuditMetadata(input: {
  input: z.infer<typeof googleCalendarRuntimeInputSchema>;
  result: unknown;
  mutationOutcome?: "confirmed" | "rejected" | "outcome_unknown";
  providerErrorCode?: string;
}) {
  if (input.input.operation === "events.create" || input.input.operation === "events.update") {
    const result = input.result as { id?: unknown; updatedAt?: unknown; attendees?: unknown };
    const eventInput = input.input.operation === "events.create"
      ? input.input.event
      : input.input.patch;
    return {
      mutationOutcome: input.mutationOutcome ?? "confirmed",
      ...(typeof result.id === "string" ? { eventId: result.id } : {}),
      ...(typeof result.updatedAt === "string" ? { updatedAt: result.updatedAt } : {}),
      ...(Array.isArray(result.attendees)
        ? { attendeeCount: result.attendees.length }
        : Array.isArray(eventInput.attendees)
          ? { attendeeCount: eventInput.attendees.length }
          : {}),
      notifyAttendees: input.input.notifyAttendees,
      ...(input.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: input.providerErrorCode }),
    };
  }
  if (input.input.operation === "events.delete") {
    return {
      mutationOutcome: input.mutationOutcome ?? "confirmed",
      eventId: input.input.eventId,
      notifyAttendees: input.input.notifyAttendees,
      ...(input.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: input.providerErrorCode }),
    };
  }
  return {};
}

async function recordGoogleCalendarMutationFailure(input: {
  ticket: EnvironmentExecutionTicket | null;
  context: {
    input: Extract<
      z.infer<typeof googleCalendarRuntimeInputSchema>,
      { operation: "events.create" | "events.update" | "events.delete" }
    >;
    connectionId: string;
    accountId: string | null;
    projectId: string;
    capability: string;
    loggingMode: string;
    runtimeApprovalId: string;
  } | null;
  error: GoogleCalendarProviderError;
}) {
  if (!input.ticket || !input.context) return;
  await logAdminEvent({
    organizationId: input.ticket.organizationId,
    actorUserId: input.ticket.actorId,
    category: "environment-tools",
    action: `google_calendar.${input.context.input.operation}`,
    targetType: "environment",
    targetId: input.ticket.environmentId,
    message: `Google Calendar ${input.context.input.operation} failed.`,
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
      providerStatus: input.error.status,
      ...googleCalendarMutationAuditMetadata({
        input: input.context.input,
        result: { status: "FAILED", errorCode: input.error.code },
        mutationOutcome: input.error.outcomeUnknown ? "outcome_unknown" : "rejected",
        providerErrorCode: input.error.code,
      }),
    },
  }).catch(() => {});
}

function readApprovalId(value: string | null) {
  const normalized = value?.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

function googleCalendarCursorSecret() {
  const secret = process.env.KESTREL_GOOGLE_CALENDAR_CURSOR_SECRET;
  if (!secret || secret.length < 32) {
    throw new GoogleCalendarPolicyError("GOOGLE_CALENDAR_CURSOR_UNAVAILABLE", 503);
  }
  return secret;
}

async function getConnectionAccessToken(input: {
  connectionId: string;
  userId: string | null;
  organizationId: string;
  projectId: string;
  operation: Parameters<typeof resolveHostedPersonalProviderToken>[0]["operation"];
}) {
  try {
    if (!input.userId) {
      throw new Error("Google account identity is unavailable.");
    }
    const token = await resolveHostedPersonalProviderToken({
      provider: "google_workspace",
      connectionId: input.connectionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.userId,
      operation: input.operation,
    });
    return token.accessToken;
  } catch (error) {
    if (error instanceof HostedPersonalOAuthError && error.code !== "OAUTH_RECONNECT_REQUIRED") {
      throw new GoogleCalendarPolicyError(error.code);
    }
    throw new GoogleCalendarProviderError({
      code: "GOOGLE_CALENDAR_RECONNECT_REQUIRED",
      status: 401,
      reconnectRequired: true,
    });
  }
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new Error("Environment execution ticket is required.");
  return match[1];
}
