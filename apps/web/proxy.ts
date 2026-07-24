import { type NextRequest, NextResponse } from "next/server";
import {
  authorizeAuthenticatedMutationOrigin,
  canonicalProductionRedirect,
  getKestrelSessionCookie,
  resolveAuthSecurityPolicy,
} from "@/lib/auth-security-policy";
import { isLocalDevAuthBypassEnabled } from "@/lib/dev-auth";

export async function proxy(request: NextRequest) {
  const sessionCookie = getKestrelSessionCookie(request);
  const authSecurityPolicy = resolveAuthSecurityPolicy(process.env);
  const canonicalRedirect = canonicalProductionRedirect({
    host: request.headers.get("host"),
    requestUrl: request.url,
    policy: authSecurityPolicy,
  });
  if (canonicalRedirect) {
    return NextResponse.redirect(canonicalRedirect, 308);
  }

  // Allow public routes without redirecting
  const publicRoutes = [
    "/", // Kestrel One landing page
    "/sign-in",
    "/sign-up",
    "/forget-password",
    "/reset-password",
    "/two-factor",
    "/accept-invitation",
    "/shared",
    "/brand",
    "/manifest.webmanifest",
    "/api/auth",
    "/api/dev/auto-login",
  ];

  const pathname = request.nextUrl.pathname;
  const isPublicRoute = publicRoutes.some((route) =>
    route === "/" ? pathname === "/" : pathname.startsWith(route)
  );

  const mutationOriginDecision = authorizeAuthenticatedMutationOrigin({
    hasSessionCookie: Boolean(sessionCookie),
    headers: request.headers,
    method: request.method,
    trustedOrigins: authSecurityPolicy.trustedOrigins,
  });
  if (!mutationOriginDecision.allowed) {
    return NextResponse.json(
      {
        error: {
          code: mutationOriginDecision.code,
          message: "Authenticated request origin is not allowed",
        },
      },
      {
        status: 403,
        headers: { "Cache-Control": "private, no-store" },
      }
    );
  }

  if (pathname.startsWith("/api/dev/auto-login")) {
    if (!isLocalDevAuthBypassEnabled(request.headers.get("host"))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    const response = NextResponse.next();
    if (pathname.startsWith("/api/mobile/v2/")) {
      response.headers.set("Cache-Control", "private, no-store");
    }
    return response;
  }

  // Don't redirect public routes
  if (isPublicRoute) {
    return NextResponse.next();
  }

  // Only redirect protected routes if no session cookie
  if (!sessionCookie) {
    if (isLocalDevAuthBypassEnabled(request.headers.get("host"))) {
      const autoLoginUrl = new URL("/api/dev/auto-login", request.url);
      autoLoginUrl.searchParams.set(
        "redirectTo",
        `${pathname}${request.nextUrl.search}`
      );
      return NextResponse.redirect(autoLoginUrl);
    }
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/).*)",
    },
  ],
};
