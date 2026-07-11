import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isLocalDevAuthBypassEnabled } from "@/lib/dev-auth";

function getRedirectUrl(request: NextRequest) {
  const redirectTo =
    request.nextUrl.searchParams.get("redirectTo") || "/dashboard";
  return new URL(redirectTo, request.url);
}

export async function GET(request: NextRequest) {
  const host = request.headers.get("host");

  if (!isLocalDevAuthBypassEnabled(host)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const email = process.env.DEV_ADMIN_EMAIL || "admin@dev.local";
  const password = process.env.DEV_ADMIN_PASSWORD || "devpass123";

  const signInResponse = await auth.api.signInEmail({
    body: {
      email,
      password,
      rememberMe: true,
      callbackURL: getRedirectUrl(request).pathname,
    },
    headers: await headers(),
    asResponse: true,
  });

  if (!signInResponse.ok) {
    return NextResponse.json(
      { error: "Dev auto-login failed" },
      { status: signInResponse.status }
    );
  }

  const response = NextResponse.redirect(getRedirectUrl(request));
  for (const cookie of signInResponse.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
