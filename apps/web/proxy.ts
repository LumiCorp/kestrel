import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { isLocalDevAuthBypassEnabled } from "@/lib/dev-auth";

export async function proxy(request: NextRequest) {
  const cookies = getSessionCookie(request);

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
    "/hawk",
    "/api/auth",
    "/api/dev/auto-login",
  ];

  const pathname = request.nextUrl.pathname;
  const isPublicRoute = publicRoutes.some((route) =>
    route === "/" ? pathname === "/" : pathname.startsWith(route)
  );

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
  if (!cookies) {
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
