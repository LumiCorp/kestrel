import assert from "node:assert/strict";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import { NextRequest } from "next/server";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import { proxy } from "../proxy";
import {
  authorizeAuthenticatedMutationOrigin,
  getKestrelSessionCookie,
  resolveAuthSecurityPolicy,
  type AuthSecurityEnvironment,
} from "./auth-security-policy";

const productionEnvironment: AuthSecurityEnvironment = {
  NODE_ENV: "production",
  BETTER_AUTH_URL: "https://kestrelagents.dev",
  NEXT_PUBLIC_APP_URL: "https://kestrelagents.dev",
};

function cookiesFor(environment: AuthSecurityEnvironment) {
  const policy = resolveAuthSecurityPolicy(environment);
  return getCookies({
    baseURL:
      environment.BETTER_AUTH_URL ??
      environment.NEXT_PUBLIC_APP_URL ??
      "http://localhost:43103",
    advanced: policy.advanced,
  } as BetterAuthOptions);
}

function authorize(input: {
  environment?: AuthSecurityEnvironment;
  hasSessionCookie?: boolean;
  headers?: HeadersInit;
  method?: string;
}) {
  const environment = input.environment ?? productionEnvironment;
  return authorizeAuthenticatedMutationOrigin({
    hasSessionCookie: input.hasSessionCookie ?? true,
    headers: new Headers(input.headers),
    method: input.method ?? "POST",
    trustedOrigins: resolveAuthSecurityPolicy(environment).trustedOrigins,
  });
}

contractTest(
  "web.auth.host-only-cookie",
  "production session cookies use the __Host- contract without a Domain attribute",
  () => {
    const sessionCookie = cookiesFor(productionEnvironment).sessionToken;

    assert.equal(sessionCookie.name, "__Host-kestrel.session_token");
    assert.equal(sessionCookie.attributes.secure, true);
    assert.equal(sessionCookie.attributes.httpOnly, true);
    assert.equal(sessionCookie.attributes.path, "/");
    assert.equal(sessionCookie.attributes.sameSite, "lax");
    assert.equal("domain" in sessionCookie.attributes, false);
  }
);

contractTest(
  "web.auth.host-only-cookie",
  "the production session detector reads the exact __Host- cookie",
  () => {
    const headers = new Headers({
      cookie: "__Host-kestrel.session_token=signed-production-session",
    });

    assert.equal(
      getKestrelSessionCookie(headers, productionEnvironment),
      "signed-production-session"
    );
  }
);

contractTest(
  "web.auth.host-only-cookie",
  "local development cookies remain host-only and work over HTTP",
  () => {
    const developmentEnvironment = {
      NODE_ENV: "development",
      BETTER_AUTH_URL: "http://localhost:43103",
    };
    const sessionCookie = cookiesFor(developmentEnvironment).sessionToken;

    assert.equal(sessionCookie.name, "kestrel.session_token");
    assert.equal(sessionCookie.attributes.secure, false);
    assert.equal("domain" in sessionCookie.attributes, false);
    assert.equal(
      getKestrelSessionCookie(
        new Headers({ cookie: "kestrel.session_token=local-session" }),
        developmentEnvironment
      ),
      "local-session"
    );
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "preview subdomains are not Better Auth trusted origins",
  () => {
    const policy = resolveAuthSecurityPolicy(productionEnvironment);

    assert.deepEqual(policy.trustedOrigins, [
      "kestrelone://",
      "https://appleid.apple.com",
      "https://kestrelagents.dev",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://localhost:3100",
      "http://127.0.0.1:3100",
      "http://localhost:43103",
      "http://127.0.0.1:43103",
    ]);
    assert.equal(
      policy.trustedOrigins.includes(
        "https://p-deadbeef.preview.kestrelagents.dev"
      ),
      false
    );
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "an authenticated mutation from a same-site preview origin is rejected",
  () => {
    assert.deepEqual(
      authorize({
        headers: {
          origin: "https://p-deadbeef.preview.kestrelagents.dev",
          "sec-fetch-site": "same-site",
        },
      }),
      { allowed: false, code: "AUTHENTICATED_ORIGIN_DENIED" }
    );
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "the web request boundary returns 403 for an authenticated preview mutation",
  async () => {
    const response = await proxy(
      new NextRequest("https://kestrelagents.dev/api/threads/thread-1", {
        method: "POST",
        headers: {
          cookie: "kestrel.session_token=signed-session",
          origin: "https://p-deadbeef.preview.kestrelagents.dev",
          "sec-fetch-site": "same-site",
        },
      })
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: {
        code: "AUTHENTICATED_ORIGIN_DENIED",
        message: "Authenticated request origin is not allowed",
      },
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "an authenticated mutation from the canonical Kestrel One origin is allowed",
  () => {
    assert.deepEqual(
      authorize({
        headers: {
          origin: "https://kestrelagents.dev",
          "sec-fetch-site": "same-origin",
        },
      }),
      { allowed: true }
    );
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "same-site browser mutations cannot bypass the check by omitting Origin",
  () => {
    assert.deepEqual(
      authorize({ headers: { "sec-fetch-site": "same-site" } }),
      { allowed: false, code: "AUTHENTICATED_ORIGIN_DENIED" }
    );
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "unauthenticated and non-browser requests remain owned by endpoint authentication",
  () => {
    assert.deepEqual(
      authorize({
        hasSessionCookie: false,
        headers: { origin: "https://p-deadbeef.preview.kestrelagents.dev" },
      }),
      { allowed: true }
    );
    assert.deepEqual(authorize({ headers: {} }), { allowed: true });
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "the configured native application origin remains allowed",
  () => {
    assert.deepEqual(
      authorize({ headers: { origin: "kestrelone://" } }),
      { allowed: true }
    );
  }
);
