import assert from "node:assert/strict";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import {
  authorizeAuthenticatedMutationOrigin,
  canonicalProductionRedirect,
  getKestrelSessionCookie,
  resolveAuthSecurityPolicy,
  type AuthSecurityEnvironment,
} from "./auth-security-policy";

contractTest(
  "web.auth.host-only-cookie",
  "canonical production redirect matches only explicit legacy hosts",
  () => {
    const policy = resolveAuthSecurityPolicy({
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://kestrelagents.dev",
      NEXT_PUBLIC_APP_URL: "https://kestrelagents.dev",
      KESTREL_LEGACY_PRODUCTION_HOSTS: "kestrel-one-green.vercel.app",
    });
    assert.equal(
      canonicalProductionRedirect({
        host: "kestrel-one-green.vercel.app",
        requestUrl: "https://kestrel-one-green.vercel.app/api/runtime/x?y=1",
        policy,
      })?.toString(),
      "https://kestrelagents.dev/api/runtime/x?y=1",
    );
    assert.equal(
      canonicalProductionRedirect({
        host: "preview-kestrel-one-green.vercel.app",
        requestUrl: "https://preview-kestrel-one-green.vercel.app/",
        policy,
      }),
      null,
    );
  },
);

const productionEnvironment: AuthSecurityEnvironment = {
  NODE_ENV: "production",
  BETTER_AUTH_URL: "https://kestrelagents.dev",
  NEXT_PUBLIC_APP_URL: "https://kestrelagents.dev",
};
const previewEnvironment: AuthSecurityEnvironment = {
  ...productionEnvironment,
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_BRANCH_URL: "kestrel-one-git-preview-example.vercel.app",
  VERCEL_URL: "kestrel-immutable-preview-example.vercel.app",
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
  "the active Vercel branch alias and immutable deployment URL are Better Auth trusted origins",
  () => {
    const policy = resolveAuthSecurityPolicy(previewEnvironment);

    assert.equal(
      policy.trustedOrigins.includes(
        "https://kestrel-one-git-preview-example.vercel.app"
      ),
      true
    );
    assert.equal(
      policy.trustedOrigins.includes(
        "https://kestrel-immutable-preview-example.vercel.app"
      ),
      true
    );
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "an authenticated mutation from the active Vercel preview origin is allowed",
  () => {
    assert.deepEqual(
      authorize({
        environment: previewEnvironment,
        headers: {
          origin: "https://kestrel-one-git-preview-example.vercel.app",
          "sec-fetch-site": "same-origin",
        },
      }),
      { allowed: true }
    );
  }
);

contractTest(
  "web.auth.preview-origin-isolation",
  "an authenticated mutation from another Vercel preview is rejected",
  () => {
    assert.deepEqual(
      authorize({
        environment: previewEnvironment,
        headers: {
          origin: "https://another-preview.vercel.app",
          "sec-fetch-site": "same-site",
        },
      }),
      { allowed: false, code: "AUTHENTICATED_ORIGIN_DENIED" }
    );
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
