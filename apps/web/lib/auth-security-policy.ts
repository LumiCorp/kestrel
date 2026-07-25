import { getSessionCookie } from "better-auth/cookies";
import { resolveKestrelAppUrl, resolveVercelPreviewOrigins } from "./app-url";

const LOCAL_DEV_ORIGINS = [3000, 3001, 3100, 43_103].flatMap((port) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type AuthSecurityEnvironment = {
  BETTER_AUTH_URL?: string;
  KESTREL_ONE_MOBILE_TRUSTED_ORIGINS?: string;
  KESTREL_LEGACY_PRODUCTION_HOSTS?: string;
  NEXT_PUBLIC_APP_URL?: string;
  NODE_ENV?: string;
  VERCEL?: string;
  VERCEL_BRANCH_URL?: string;
  VERCEL_ENV?: string;
  VERCEL_URL?: string;
};

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
  } catch {
    // Better Auth validates malformed configured origins during initialization.
  }
  return trimmed;
}

export function resolveAuthSecurityPolicy(
  environment: AuthSecurityEnvironment
) {
  const isProduction = environment.NODE_ENV === "production";
  const configuredAppUrl = resolveKestrelAppUrl(environment);
  const vercelPreviewOrigins = resolveVercelPreviewOrigins(environment);
  const mobileTrustedOrigins = (
    environment.KESTREL_ONE_MOBILE_TRUSTED_ORIGINS ?? "kestrelone://"
  )
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  const trustedOrigins = Array.from(
    new Set(
      [
        ...(isProduction ? [] : ["exp://"]),
        ...mobileTrustedOrigins,
        "https://appleid.apple.com",
        configuredAppUrl,
        ...vercelPreviewOrigins,
        ...LOCAL_DEV_ORIGINS,
      ]
        .filter((origin): origin is string => Boolean(origin))
        .map(normalizeOrigin)
    )
  );
  const cookiePrefix = isProduction ? "__Host-kestrel" : "kestrel";
  const canonicalOrigin = normalizeOrigin(configuredAppUrl);
  const legacyProductionHosts = (
    environment.KESTREL_LEGACY_PRODUCTION_HOSTS ?? ""
  )
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => /^[a-z0-9.-]+$/u.test(host));

  return {
    cookiePrefix,
    canonicalOrigin,
    legacyProductionHosts,
    trustedOrigins,
    advanced: {
      cookiePrefix,
      // The literal production cookiePrefix already carries __Host-. Disabling
      // Better Auth's automatic prefix prevents it becoming __Secure-__Host-*.
      useSecureCookies: false,
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax" as const,
        secure: isProduction,
      },
      crossSubDomainCookies: {
        enabled: false,
      },
    },
  };
}

export function canonicalProductionRedirect(input: {
  host: string | null;
  requestUrl: string;
  policy: ReturnType<typeof resolveAuthSecurityPolicy>;
}) {
  const host = input.host?.trim().toLowerCase().split(":")[0] ?? "";
  if (
    !host ||
    !input.policy.canonicalOrigin ||
    !input.policy.legacyProductionHosts.includes(host)
  ) {
    return null;
  }
  const target = new URL(input.requestUrl);
  const canonical = new URL(input.policy.canonicalOrigin);
  target.protocol = canonical.protocol;
  target.hostname = canonical.hostname;
  target.port = canonical.port;
  return target;
}

export function getKestrelSessionCookie(
  request: Request | Headers,
  environment: AuthSecurityEnvironment = process.env
) {
  return getSessionCookie(request, {
    cookiePrefix: resolveAuthSecurityPolicy(environment).cookiePrefix,
  });
}

export type AuthenticatedMutationOriginDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "AUTHENTICATED_ORIGIN_DENIED";
    };

export function authorizeAuthenticatedMutationOrigin(input: {
  hasSessionCookie: boolean;
  headers: Headers;
  method: string;
  trustedOrigins: readonly string[];
}): AuthenticatedMutationOriginDecision {
  if (
    SAFE_METHODS.has(input.method.toUpperCase()) ||
    !input.hasSessionCookie
  ) {
    return { allowed: true };
  }

  const origin = input.headers.get("origin");
  if (origin) {
    return input.trustedOrigins.includes(normalizeOrigin(origin))
      ? { allowed: true }
      : { allowed: false, code: "AUTHENTICATED_ORIGIN_DENIED" };
  }

  const fetchSite = input.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return { allowed: false, code: "AUTHENTICATED_ORIGIN_DENIED" };
  }

  // Non-browser clients do not consistently send Origin or Fetch Metadata.
  // Endpoint authentication remains authoritative for those requests.
  return { allowed: true };
}
