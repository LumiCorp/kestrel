import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@/lib/auth-types";
import {
  MobileSessionError,
  mobileSessionFailureFacts,
  resolveMobileSession,
} from "./session";

const validSession = {
  user: { id: "user-1", name: "Mobile User", email: "mobile@example.test" },
  session: { id: "session-1", activeOrganizationId: "org-1" },
} as unknown as Session;

function dependencies(input?: {
  getSession?: (input: { headers: Headers }) => Promise<Session | null>;
  membership?: { id: string } | null;
  membershipError?: Error;
  environmentError?: Error;
}) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      getSession: async (request: { headers: Headers }) => {
        calls.push("session");
        return input?.getSession?.(request) ?? validSession;
      },
      findMembership: async () => {
        calls.push("membership");
        if (input?.membershipError) throw input.membershipError;
        return input?.membership === undefined
          ? { id: "member-1" }
          : input.membership;
      },
      ensurePersonalOrganization: async () => {
        calls.push("personal-organization");
        return { id: "org-personal" };
      },
      ensureDefaultEnvironment: async () => {
        calls.push("environment");
        if (input?.environmentError) throw input.environmentError;
        return {};
      },
      enqueueEnvironmentOperation: async () => {
        calls.push("enqueue");
      },
    },
  };
}

async function assertValidCredential(headers: HeadersInit) {
  const fixture = dependencies({
    getSession: async ({ headers: received }) => {
      const [name, value] = Object.entries(headers)[0] ?? [];
      assert.equal(received.get(name ?? ""), value);
      return validSession;
    },
  });
  const request = new Request("https://kestrel.one/api/mobile/v2/bootstrap", {
    headers,
  });
  const result = await resolveMobileSession(request, fixture.value);

  assert.equal(result.session.user.id, "user-1");
  assert.equal(result.organizationId, "org-1");
  assert.deepEqual(fixture.calls, ["session", "membership", "environment"]);
}

test("accepts a valid Better Auth cookie through the incoming request headers", () =>
  assertValidCredential({ cookie: "better-auth.session_token=signed-cookie" }));

test("accepts a valid signed-session Bearer through the incoming request headers", () =>
  assertValidCredential({ authorization: "Bearer signed-session" }));

test("accepts a valid personal API key through the incoming request headers", () =>
  assertValidCredential({ "x-api-key": "personal-key" }));

async function assertRejectedSession() {
  const fixture = dependencies({ getSession: async () => null });

  await assert.rejects(
    resolveMobileSession(
      new Request("https://kestrel.one/api/mobile/v2/bootstrap"),
      fixture.value
    ),
    (error: unknown) =>
      error instanceof MobileSessionError && error.code === "UNAUTHORIZED"
  );
  assert.deepEqual(fixture.calls, ["session"]);
}

test("missing sessions stop at the authentication boundary", assertRejectedSession);

test("expired sessions stop at the authentication boundary", assertRejectedSession);

test("revoked sessions stop at the authentication boundary", assertRejectedSession);

test("organization membership is resolved only after the session and is not a 401", async () => {
  const fixture = dependencies({ membership: null });

  await assert.rejects(
    resolveMobileSession(
      new Request("https://kestrel.one/api/mobile/v2/bootstrap"),
      fixture.value
    ),
    (error: unknown) =>
      error instanceof MobileSessionError &&
      error.code === "ORGANIZATION_MEMBERSHIP_REQUIRED"
  );
  assert.deepEqual(fixture.calls, ["session", "membership"]);
});

async function assertConfigurationFailure(
  fixture: ReturnType<typeof dependencies>
) {
  await assert.rejects(
    resolveMobileSession(
      new Request("https://kestrel.one/api/mobile/v2/bootstrap"),
      fixture.value
    ),
    (error: unknown) =>
      error instanceof MobileSessionError &&
      error.code === "ORGANIZATION_CONFIGURATION_ERROR"
  );
}

test("membership lookup failures remain configuration errors", () =>
  assertConfigurationFailure(
    dependencies({ membershipError: new Error("db") })
  ));

test("environment configuration failures remain configuration errors", () =>
  assertConfigurationFailure(
    dependencies({ environmentError: new Error("config") })
  ));

test("failure telemetry records only safe authentication-presence facts", () => {
  const request = new Request(
    "https://kestrel.one/api/mobile/v2/threads/thread-secret",
    {
      headers: {
        authorization: "Bearer signed-session-secret",
        cookie: "better-auth.session_token=cookie-secret",
        "x-api-key": "personal-api-key-secret",
      },
    }
  );
  const facts = mobileSessionFailureFacts(
    request,
    new MobileSessionError("UNAUTHORIZED", "Mobile session required")
  );

  assert.deepEqual(facts, {
    path: "/api/mobile/v2/threads/thread-secret",
    status: 401,
    code: "UNAUTHORIZED",
    hasCookie: true,
    hasBetterAuthSessionCookie: true,
    hasAuthorization: true,
    hasApiKey: true,
  });
  const serialized = JSON.stringify(facts);
  assert.doesNotMatch(serialized, /signed-session-secret/u);
  assert.doesNotMatch(serialized, /cookie-secret/u);
  assert.doesNotMatch(serialized, /personal-api-key-secret/u);
});
