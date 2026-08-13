import { NextResponse } from "next/server";
import { requireInstalledAppForOrganization } from "@/lib/apps/service";
import { auth } from "@/lib/auth";
import { findGithubAuthAccount } from "@/lib/integrations/github-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    await requireInstalledAppForOrganization({
      organizationId,
      appKey: "github",
    });
    if (!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)) {
      throw new Error("GitHub OAuth is not configured.");
    }
    const existing = await findGithubAuthAccount(session.user.id);
    if (existing) {
      return NextResponse.json({ linked: true, url: null });
    }
    const origin = new URL(request.url).origin;
    const result = await auth.api.linkSocialAccount({
      headers: request.headers,
      body: {
        provider: "github",
        scopes: ["repo"],
        callbackURL: `${origin}/settings/connections?github=linked#github`,
        errorCallbackURL: `${origin}/settings/connections?github=error#github`,
        disableRedirect: true,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
