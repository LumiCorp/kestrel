import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  findGithubAuthAccount,
  syncGithubUserConnection,
} from "@/lib/integrations/github-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const account = await findGithubAuthAccount(session.user.id);
    if (!account) {
      throw new Error(
        "Link a GitHub account before synchronizing repositories."
      );
    }
    const token = await auth.api.getAccessToken({
      headers: request.headers,
      body: {
        providerId: "github",
        accountId: account.accountId,
        userId: session.user.id,
      },
    });
    const result = await syncGithubUserConnection({
      organizationId,
      userId: session.user.id,
      authAccountId: account.id,
      providerAccountId: account.accountId,
      accessToken: token.accessToken,
      scopes: token.scopes,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
