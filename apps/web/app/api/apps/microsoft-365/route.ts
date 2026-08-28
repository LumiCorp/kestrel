import { NextResponse } from "next/server";
import {
  microsoft365ConnectionInputSchema,
  requireMicrosoft365TeamsConnectionPacks,
} from "@/lib/integrations/microsoft-365-contract";
import {
  disconnectMicrosoft365Connection,
  findMicrosoft365Connection,
  packsFromMicrosoft365Connection,
} from "@/lib/integrations/microsoft-365-oauth";
import {
  publicHostedPersonalOAuthHealth,
  startHostedPersonalAuthorization,
} from "@/lib/integrations/hosted-personal-oauth";
import { resolvePlatformOAuthRegistration } from "@/lib/apps/platform-oauth-registrations";
import { knowledgeDb } from "@/lib/knowledge/db";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const [registration, connection] = await Promise.all([
      resolvePlatformOAuthRegistration("microsoft_365"),
      findMicrosoft365Connection({
        organizationId,
        userId: session.user.id,
      }),
    ]);
    const authorization = connection
      ? await knowledgeDb.query.platformPersonalOAuthAuthorizations.findFirst({
          where: (table, { eq }) => eq(table.connectionId, connection.id),
          columns: {
            reconnectRequired: true,
            failureCode: true,
            registrationRevision: true,
          },
        })
      : null;
    return NextResponse.json({
      configured: registration.status === "ready",
      linked: Boolean(authorization),
      connected: Boolean(authorization) && connection?.status === "connected",
      status: connection?.status ?? null,
      label: connection?.externalAccountLabel ?? null,
      packs: packsFromMicrosoft365Connection(connection),
      grantedScopes: connection?.scopes ?? [],
      health: authorization
        ? publicHostedPersonalOAuthHealth({
            status: connection?.status ?? "disconnected",
            reconnectRequired: authorization.reconnectRequired,
            failureCode: authorization.failureCode,
            registrationRevision: authorization.registrationRevision,
          })
        : null,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { packs } = microsoft365ConnectionInputSchema.parse(
      await request.json()
    );
    const teamsPacks = requireMicrosoft365TeamsConnectionPacks(packs);
    const result = await startHostedPersonalAuthorization({
      provider: "microsoft_365",
      organizationId,
      userId: session.user.id,
      packs: teamsPacks,
    });
    return NextResponse.json({ url: result.authorizationUrl, packs: teamsPacks });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const connection = await disconnectMicrosoft365Connection({
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
