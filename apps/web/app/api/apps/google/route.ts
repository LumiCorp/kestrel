import { NextResponse } from "next/server";
import { requireInstalledAppForOrganization } from "@/lib/apps/service";
import { auth } from "@/lib/auth";
import {
  GOOGLE_CALENDAR_SCOPES,
  googleCalendarPersonalConnectionInputSchema,
  parseGoogleOAuthScopes,
  shouldStartGoogleCalendarOAuth,
} from "@/lib/integrations/google-calendar-contract";
import {
  disconnectGoogleCalendarUserConnection,
  findGoogleAuthAccount,
  findGoogleCalendarUserConnection,
  syncGoogleCalendarUserConnection,
} from "@/lib/integrations/google-calendar-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const [account, connection] = await Promise.all([
      findGoogleAuthAccount(session.user.id),
      findGoogleCalendarUserConnection({
        organizationId,
        userId: session.user.id,
      }),
    ]);
    return NextResponse.json({
      configured: Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
      ),
      linked: Boolean(account),
      connected: connection?.status === "connected",
      status: connection?.status ?? null,
      label: connection?.externalAccountLabel ?? null,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    googleCalendarPersonalConnectionInputSchema.parse(await request.json());
    await requireInstalledAppForOrganization({
      organizationId,
      appKey: "google_workspace",
    });
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
      const token = await auth.api
        .getAccessToken({
          headers: request.headers,
          body: {
            providerId: "google",
            accountId: account.accountId,
            userId: session.user.id,
          },
        })
        .catch(() => null);
      if (token) {
        const scopes = Array.from(
          new Set([
            ...parseGoogleOAuthScopes(account.scope),
            ...(Array.isArray(token.scopes) ? token.scopes : []),
          ]),
        );
        const synced = await syncGoogleCalendarUserConnection({
          organizationId,
          userId: session.user.id,
          authAccountId: account.id,
          providerAccountId: account.accountId,
          accessToken: token.accessToken,
          scopes,
        });
        return NextResponse.json({ connected: true, connection: synced });
      }
    }

    const origin = new URL(request.url).origin;
    const callback = new URL("/settings/connections", origin);
    callback.searchParams.set("google", "linked");
    callback.hash = "google-workspace";
    const errorCallback = new URL(callback);
    errorCallback.searchParams.set("google", "error");
    const result = await auth.api.linkSocialAccount({
      headers: request.headers,
      body: {
        provider: "google",
        scopes: [...GOOGLE_CALENDAR_SCOPES],
        callbackURL: callback.toString(),
        errorCallbackURL: errorCallback.toString(),
        disableRedirect: true,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const connection = await disconnectGoogleCalendarUserConnection({
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
