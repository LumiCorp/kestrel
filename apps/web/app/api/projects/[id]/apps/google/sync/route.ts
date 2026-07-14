import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { auth } from "@/lib/auth";
import { GoogleCalendarProviderError } from "@/lib/integrations/google-calendar-api";
import {
  googleCalendarConnectionInputSchema,
  hasRequiredGoogleCalendarScopes,
  parseGoogleOAuthScopes,
} from "@/lib/integrations/google-calendar-contract";
import {
  findGoogleAuthAccount,
  findGoogleCalendarUserConnection,
  markGoogleCalendarConnectionDegraded,
  syncGoogleCalendarUserConnection,
} from "@/lib/integrations/google-calendar-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = await context.params;
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
    });
    const input = googleCalendarConnectionInputSchema.parse(
      await request.json()
    );
    const account = await findGoogleAuthAccount(session.user.id);
    if (!account) {
      throw new Error("Link a Google account before enabling Calendar.");
    }
    let token: Awaited<ReturnType<typeof auth.api.getAccessToken>>;
    try {
      token = await auth.api.getAccessToken({
        headers: request.headers,
        body: {
          providerId: "google",
          accountId: account.accountId,
          userId: session.user.id,
        },
      });
    } catch {
      const connection = await findGoogleCalendarUserConnection({
        organizationId,
        userId: session.user.id,
      });
      if (connection) {
        await markGoogleCalendarConnectionDegraded({
          connectionId: connection.id,
          failureCode: "GOOGLE_CALENDAR_RECONNECT_REQUIRED",
        });
      }
      throw new GoogleCalendarProviderError({
        code: "GOOGLE_CALENDAR_RECONNECT_REQUIRED",
        status: 401,
        reconnectRequired: true,
      });
    }
    const scopes = Array.from(
      new Set([
        ...parseGoogleOAuthScopes(account.scope),
        ...(Array.isArray(token.scopes) ? token.scopes : []),
      ])
    );
    if (!hasRequiredGoogleCalendarScopes(scopes)) {
      throw new Error("Google Calendar permission approval is incomplete.");
    }
    const connection = await syncGoogleCalendarUserConnection({
      organizationId,
      projectId: id,
      userId: session.user.id,
      authAccountId: account.id,
      providerAccountId: account.accountId,
      accessToken: token.accessToken,
      scopes,
      shareAvailability: input.shareAvailability,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "projects",
      action: "project.google_calendar.connected",
      targetType: "project",
      targetId: id,
      message: "Connected Google Calendar to the Project.",
      metadata: {
        connectionId: connection.id,
        shareAvailability: input.shareAvailability,
      },
    });
    return NextResponse.json({ connected: true });
  } catch (error) {
    if (error instanceof GoogleCalendarProviderError) {
      return NextResponse.json(
        {
          error: "Reconnect Google Calendar and try again.",
          code: error.code,
          reconnectRequired: error.reconnectRequired,
        },
        { status: error.status }
      );
    }
    return errorResponse(error, 400);
  }
}
