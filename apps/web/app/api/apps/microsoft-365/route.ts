import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { auth } from "@/lib/auth";
import {
  hasMicrosoft365PackScopes,
  MICROSOFT_365_AUTH_PROVIDER_ID,
  microsoft365ConnectionInputSchema,
  parseMicrosoftOAuthScopes,
  scopesForMicrosoft365Packs,
} from "@/lib/integrations/microsoft-365-contract";
import {
  findMicrosoft365Connection,
  findMicrosoftAuthAccount,
  packsFromMicrosoft365Connection,
  syncMicrosoft365Connection,
} from "@/lib/integrations/microsoft-365-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const [account, connection] = await Promise.all([
      findMicrosoftAuthAccount(session.user.id),
      findMicrosoft365Connection({
        organizationId,
        userId: session.user.id,
      }),
    ]);
    return NextResponse.json({
      configured: Boolean(
        process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
      ),
      linked: Boolean(account),
      connected: connection?.status === "connected",
      status: connection?.status ?? null,
      label: connection?.externalAccountLabel ?? null,
      packs: packsFromMicrosoft365Connection(connection),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    if (!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET)) {
      throw new Error("Microsoft 365 connection is not configured for this deployment.");
    }
    const { packs } = microsoft365ConnectionInputSchema.parse(
      await request.json()
    );
    const account = await findMicrosoftAuthAccount(session.user.id);
    if (account) {
      const token = await auth.api
        .getAccessToken({
          headers: request.headers,
          body: {
            providerId: MICROSOFT_365_AUTH_PROVIDER_ID,
            accountId: account.accountId,
            userId: session.user.id,
          },
        })
        .catch(() => null);
      const scopes = Array.from(
        new Set([
          ...parseMicrosoftOAuthScopes(account.scope),
          ...(Array.isArray(token?.scopes) ? token.scopes : []),
        ])
      );
      if (
        token &&
        hasMicrosoft365PackScopes({ grantedScopes: scopes, packs })
      ) {
        const connection = await syncMicrosoft365Connection({
          organizationId,
          userId: session.user.id,
          authAccountId: account.id,
          providerAccountId: account.accountId,
          accessToken: token.accessToken,
          scopes,
          packs,
        });
        await logAdminEvent({
          organizationId,
          actorUserId: session.user.id,
          category: "apps",
          action: "microsoft_365.connected",
          targetType: "app_connection",
          targetId: connection.id,
          message: "Connected Microsoft 365 capability packs.",
          metadata: { packs },
        });
        return NextResponse.json({ connected: true, packs });
      }
    }

    const origin = new URL(request.url).origin;
    const callback = new URL("/apps/microsoft_365", origin);
    callback.searchParams.set("microsoft365", "linked");
    callback.searchParams.set("packs", packs.join(","));
    const errorCallback = new URL(callback);
    errorCallback.searchParams.set("microsoft365", "error");
    const result = await auth.api.oAuth2LinkAccount({
      headers: request.headers,
      body: {
        providerId: MICROSOFT_365_AUTH_PROVIDER_ID,
        scopes: scopesForMicrosoft365Packs(packs),
        callbackURL: callback.toString(),
        errorCallbackURL: errorCallback.toString(),
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
