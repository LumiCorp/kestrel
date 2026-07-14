import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { auth } from "@/lib/auth";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  GoogleCalendarProviderError,
  listGoogleCalendarEvents,
  queryGoogleCalendarFreeBusy,
  updateGoogleCalendarEvent,
} from "@/lib/integrations/google-calendar-api";
import {
  assertGoogleCalendarRange,
  capabilityForGoogleCalendarOperation,
  googleCalendarRuntimeInputSchema,
} from "@/lib/integrations/google-calendar-contract";
import { markGoogleCalendarConnectionDegraded } from "@/lib/integrations/google-calendar-oauth";
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
    if (
      policy.approvalMode === "ask" &&
      request.headers.get("x-kestrel-runtime-approval") !== "confirmed"
    ) {
      throw new GoogleCalendarPolicyError(
        "GOOGLE_CALENDAR_APPROVAL_REQUIRED",
        409
      );
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
                providerAccountId: subject.providerAccountId,
                userId: subject.userId,
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
        providerAccountId: policy.connection.externalAccountId,
        userId: ticket.actorId,
      });
      connectionIdsUsed.add(policy.connection.id);
      if (input.operation === "events.list") {
        result = await listGoogleCalendarEvents({
          accessToken,
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          maxResults: input.maxResults,
        });
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
        loggingMode: policy.loggingMode,
        subjectCount,
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
    if (error instanceof GoogleCalendarProviderError) {
      if (error.reconnectRequired) {
        await Promise.all(
          [...connectionIdsUsed].map((connectionId) =>
            markGoogleCalendarConnectionDegraded({
              connectionId,
              failureCode: error.code,
            })
          )
        ).catch(() => {});
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

async function getConnectionAccessToken(input: {
  connectionId: string;
  providerAccountId: string | null;
  userId: string | null;
}) {
  try {
    if (!(input.providerAccountId && input.userId)) {
      throw new Error("Google account identity is unavailable.");
    }
    const token = await auth.api.getAccessToken({
      body: {
        providerId: "google",
        accountId: input.providerAccountId,
        userId: input.userId,
      },
    });
    return token.accessToken;
  } catch {
    await markGoogleCalendarConnectionDegraded({
      connectionId: input.connectionId,
      failureCode: "GOOGLE_CALENDAR_RECONNECT_REQUIRED",
    });
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
