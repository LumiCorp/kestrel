import { NextResponse } from "next/server";
import { disconnectPersonalAppConnection } from "@/lib/apps/service";
import {
  googleCalendarPersonalConnectionInputSchema,
  googleWorkspacePackHealth,
  parseSelectedGoogleWorkspacePacks,
} from "@/lib/integrations/google-calendar-contract";
import {
  findGoogleCalendarUserConnection,
} from "@/lib/integrations/google-calendar-oauth";
import {
  startHostedPersonalAuthorization,
} from "@/lib/integrations/hosted-personal-oauth";
import { resolvePlatformOAuthRegistration } from "@/lib/apps/platform-oauth-registrations";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const [connection, registration] = await Promise.all([
      findGoogleCalendarUserConnection({
        organizationId,
        userId: session.user.id,
      }),
      resolvePlatformOAuthRegistration("google_workspace"),
    ]);
    const selectedPacks = parseSelectedGoogleWorkspacePacks(
      connection?.deliveryConfig,
    );
    return NextResponse.json({
      configured: registration.status === "ready",
      linked: Boolean(connection && connection.status !== "disconnected"),
      connected: connection?.status === "connected",
      status: connection?.status ?? null,
      label: connection?.externalAccountLabel ?? null,
      selectedPacks,
      packHealth: googleWorkspacePackHealth({
        selectedPacks,
        grantedScopes: connection?.scopes ?? [],
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const input = googleCalendarPersonalConnectionInputSchema.parse(
      await request.json(),
    );
    const result = await startHostedPersonalAuthorization({
      provider: "google_workspace",
      organizationId,
      userId: session.user.id,
      packs: input.packs,
    });
    return NextResponse.json({ url: result.authorizationUrl }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const connection = await disconnectPersonalAppConnection({
      organizationId,
      userId: session.user.id,
      appKey: "google_workspace",
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
