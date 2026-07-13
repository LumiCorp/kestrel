import { NextResponse } from "next/server";
import {
  disconnectGithubUserConnection,
  findGithubAuthAccount,
} from "@/lib/integrations/github-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const [account, connection] = await Promise.all([
      findGithubAuthAccount(session.user.id),
      knowledgeDb.query.userToolConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, organizationId),
            eq(table.providerKey, "github"),
            eq(table.userId, session.user.id)
          ),
      }),
    ]);
    return NextResponse.json({
      oauthConfigured: Boolean(
        process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ),
      linked: Boolean(account),
      connection: connection ?? null,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE() {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const connection = await disconnectGithubUserConnection({
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
