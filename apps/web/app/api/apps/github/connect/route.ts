import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findGithubAuthAccount } from "@/lib/integrations/github-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  try {
    const { session } = await requireActiveOrganization();
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
        callbackURL: `${origin}/apps/github?github=linked`,
        errorCallbackURL: `${origin}/apps/github?github=error`,
        disableRedirect: true,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
