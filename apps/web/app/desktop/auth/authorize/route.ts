import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  createDesktopAuthorizationCode,
  parseDesktopAuthorizationRequest,
} from "@/lib/desktop-account";

export async function GET(request: Request) {
  try {
    const parsed = parseDesktopAuthorizationRequest(
      new URL(request.url).searchParams,
    );
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
      const callbackUrl = `${new URL(request.url).pathname}${new URL(request.url).search}`;
      return NextResponse.redirect(
        new URL(
          `/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`,
          request.url,
        ),
      );
    }
    const code = await createDesktopAuthorizationCode({
      userId: session.user.id,
      redirectUri: parsed.redirect_uri,
      codeChallenge: parsed.code_challenge,
    });
    const redirect = new URL(parsed.redirect_uri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", parsed.state);
    return NextResponse.redirect(redirect);
  } catch {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
