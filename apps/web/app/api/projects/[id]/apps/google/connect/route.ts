import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  GOOGLE_CALENDAR_SCOPES,
  googleCalendarConnectionInputSchema,
  parseGoogleOAuthScopes,
  shouldStartGoogleCalendarOAuth,
} from "@/lib/integrations/google-calendar-contract";
import {
  findGoogleAuthAccount,
  findGoogleCalendarUserConnection,
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
    if (!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
      throw new Error("Google OAuth credentials are not configured.");
    }
    const [account, connection] = await Promise.all([
      findGoogleAuthAccount(session.user.id),
      findGoogleCalendarUserConnection({
        organizationId,
        userId: session.user.id,
      }),
    ]);
    if (
      account &&
      !shouldStartGoogleCalendarOAuth({
        scopes: parseGoogleOAuthScopes(account.scope),
        connectionStatus: connection?.status ?? null,
      })
    ) {
      return NextResponse.json({ linked: true, url: null });
    }
    const origin = new URL(request.url).origin;
    const callback = new URL(`/projects/${id}`, origin);
    callback.searchParams.set("tab", "apps");
    callback.searchParams.set("google", "linked");
    callback.searchParams.set(
      "shareAvailability",
      input.shareAvailability ? "1" : "0"
    );
    const errorCallback = new URL(callback);
    errorCallback.searchParams.set("google", "error");
    let result: Awaited<ReturnType<typeof auth.api.linkSocialAccount>>;
    try {
      result = await auth.api.linkSocialAccount({
        headers: request.headers,
        body: {
          provider: "google",
          scopes: [...GOOGLE_CALENDAR_SCOPES],
          callbackURL: callback.toString(),
          errorCallbackURL: errorCallback.toString(),
          disableRedirect: true,
        },
      });
    } catch {
      throw new Error("Google Calendar authorization could not be started.");
    }
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
