import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { z } from "zod";
import { DesktopUserAuthorizationError } from "@/lib/desktop-account";
import { ReceivingConfigError } from "./receiving-config";
import {
  createDesktopReceivingDomainsPostHandler,
  createDesktopReceivingPutHandler,
  createOneReceivingActivationPostHandler,
  createOneReceivingDomainsPostHandler,
  createOneReceivingPutHandler,
} from "./receiving-admin-route-handlers";
import {
  getSafeReceivingAdminError,
  parseReceivingAdminJson,
} from "./receiving-admin-error";

const receivingHandlers = fs.readFileSync(
  new URL("./receiving-admin-route-handlers.ts", import.meta.url),
  "utf8",
);

test("Desktop authorization failures retain the stable receiving 401 contract", () => {
  assert.deepEqual(
    getSafeReceivingAdminError(
      new DesktopUserAuthorizationError("DESKTOP_USER_TOKEN_INVALID"),
    ),
    {
      status: 401,
      body: { code: "UNAUTHORIZED", error: "Unauthorized" },
    },
  );
});

test("receiving authorization and internal errors stay redacted", () => {
  assert.deepEqual(getSafeReceivingAdminError(new Error("Forbidden")), {
    status: 403,
    body: { code: "FORBIDDEN", error: "Forbidden" },
  });

  const secret = "re_internal_detail_must_not_escape";
  const internal = getSafeReceivingAdminError(new Error(secret));
  assert.equal(internal.status, 500);
  assert.equal(JSON.stringify(internal).includes(secret), false);
  assert.deepEqual(internal.body, {
    code: "RESEND_RECEIVING_OPERATION_FAILED",
    error: "Inbound receiving operation failed.",
  });
});

test("receiving provider failures have stable actionable HTTP status classes", () => {
  const cases = [
    {
      code: "RESEND_RECEIVING_PROVIDER_UNAVAILABLE",
      status: 503,
      error: "Resend receiving is temporarily unavailable.",
    },
    {
      code: "RESEND_RECEIVING_RESPONSE_INVALID",
      status: 502,
      error: "Resend returned an invalid receiving response.",
    },
    {
      code: "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT",
      status: 409,
      error: "Resend receiving requires a Full access API key.",
    },
    {
      code: "RESEND_RECEIVING_DOMAIN_INVALID",
      status: 422,
      error: "The selected Resend resource is unavailable.",
    },
    {
      code: "RESEND_RECEIVING_REQUEST_INVALID",
      status: 422,
      error: "Resend rejected the receiving request.",
    },
    {
      code: "RESEND_RECEIVING_DOMAIN_NOT_READY",
      status: 422,
      error:
        "Choose a verified Resend receiving domain with healthy MX records.",
    },
    {
      code: "RESEND_RECEIVING_SAVE_SUPERSEDED",
      status: 409,
      error:
        "The receiving configuration changed while receiving was being saved. Refresh and try again.",
    },
    {
      code: "RESEND_RECEIVING_ORGANIZATION_UNAVAILABLE",
      status: 409,
      error:
        "Inbound receiving is unavailable while the Organization is being deleted.",
    },
    {
      code: "RESEND_RECEIVING_WEBHOOK_KEY_AUTHORITY_CONFLICT",
      status: 409,
      error:
        "The replacement Resend credential cannot manage the existing receiving webhook.",
    },
    {
      code: "RESEND_RECEIVING_WEBHOOK_STAGING_FAILED",
      status: 503,
      error: "Resend webhook staging is temporarily unavailable.",
    },
    {
      code: "RESEND_RECEIVING_WEBHOOK_CONFLICT",
      status: 409,
      error: "Resend webhook staging requires operator review.",
    },
    {
      code: "RESEND_RECEIVING_WEBHOOK_INVALID",
      status: 502,
      error: "Resend returned invalid webhook staging evidence.",
    },
    {
      code: "RESEND_RECEIVING_WEBHOOK_NOT_READY",
      status: 409,
      error: "Inbound receiving is not ready to enable.",
    },
    {
      code: "RESEND_RECEIVING_WEBHOOK_ACTIVATION_FAILED",
      status: 503,
      error: "Inbound receiving could not be enabled. It remains disabled.",
    },
    {
      code: "RESEND_RECEIVING_WEBHOOK_DISABLE_FAILED",
      status: 503,
      error: "Inbound receiving remains closed while Resend disablement is retried.",
    },
  ] as const;
  const secret = "re_provider_detail_must_not_escape";

  for (const expected of cases) {
    const safe = getSafeReceivingAdminError(
      new ReceivingConfigError(expected.code, secret),
    );
    assert.deepEqual(safe, {
      status: expected.status,
      body: { code: expected.code, error: expected.error },
    });
    assert.equal(JSON.stringify(safe).includes(secret), false);
  }
});

test("One records the receiving update audit only after the save succeeds", () => {
  const save = receivingHandlers.indexOf(
    "const connection = await saveReceivingConnection",
  );
  const audit = receivingHandlers.indexOf("await logAdminEvent", save);
  const success = receivingHandlers.indexOf(
    "return NextResponse.json({ connection })",
    audit,
  );

  assert.ok(save >= 0);
  assert.ok(audit > save);
  assert.ok(success > audit);
});

test("invalid receiving request bodies are non-retryable correction responses", () => {
  const requestError = z.object({ domain: z.string() }).safeParse({});
  assert.equal(requestError.success, false);
  if (requestError.success) return;

  assert.deepEqual(getSafeReceivingAdminError(requestError.error), {
    status: 422,
    body: {
      code: "RESEND_RECEIVING_REQUEST_INVALID",
      error: "Invalid inbound receiving request.",
    },
  });
});

test("malformed receiving JSON is a non-retryable correction response", async () => {
  await assert.rejects(
    parseReceivingAdminJson(
      new Request("http://localhost/api/organization/email/receiving", {
        method: "PUT",
        body: "{",
        headers: { "content-type": "application/json" },
      }),
    ),
    (error: unknown) => {
      assert.deepEqual(getSafeReceivingAdminError(error), {
        status: 422,
        body: {
          code: "RESEND_RECEIVING_REQUEST_INVALID",
          error: "Invalid inbound receiving request.",
        },
      });
      return true;
    },
  );
});

test("only Kestrel's explicit JSON parsing syntax errors use the invalid-request contract", async () => {
  const internalSyntaxError = new SyntaxError("internal detail");
  assert.deepEqual(getSafeReceivingAdminError(internalSyntaxError), {
    status: 500,
    body: {
      code: "RESEND_RECEIVING_OPERATION_FAILED",
      error: "Inbound receiving operation failed.",
    },
  });

  const bodyReadSyntaxError = new SyntaxError("body reader internal detail");
  const request = new Request(
    "http://localhost/api/organization/email/receiving",
    {
      method: "PUT",
      body: "{}",
    },
  );
  request.text = async () => {
    throw bodyReadSyntaxError;
  };
  await assert.rejects(parseReceivingAdminJson(request), (error: unknown) => {
    assert.equal(error, bodyReadSyntaxError);
    assert.deepEqual(getSafeReceivingAdminError(error), {
      status: 500,
      body: {
        code: "RESEND_RECEIVING_OPERATION_FAILED",
        error: "Inbound receiving operation failed.",
      },
    });
    return true;
  });
});

test("all five receiving mutations return the exact invalid-request response for authorized malformed JSON", async () => {
  const cases = receivingMutationCases({
    requireOneAdmin: async () => ({
      organizationId: "organization-route-contract",
      session: { user: { id: "user-route-contract" } },
    }),
    requireDesktopAdmin: async () => ({ id: "user-route-contract" }),
  });

  for (const mutation of cases) {
    const response = await mutation.invoke(malformedRequest(mutation.url));
    assert.equal(response.status, 422, mutation.name);
    assert.deepEqual(await response.json(), invalidRequestBody, mutation.name);
  }
});

test("all five receiving mutations reject unauthenticated and non-Admin callers before reading malformed JSON", async () => {
  const authorizationCases = [
    {
      message: "Unauthorized",
      status: 401,
      body: { code: "UNAUTHORIZED", error: "Unauthorized" },
    },
    {
      message: "Forbidden",
      status: 403,
      body: { code: "FORBIDDEN", error: "Forbidden" },
    },
  ] as const;

  for (const authorization of authorizationCases) {
    const reject = async () => {
      throw new Error(authorization.message);
    };
    const cases = receivingMutationCases({
      requireOneAdmin: reject,
      requireDesktopAdmin: reject,
    });

    for (const mutation of cases) {
      const { request, readCount } = trackedMalformedRequest(mutation.url);
      const response = await mutation.invoke(request);
      assert.equal(response.status, authorization.status, mutation.name);
      assert.deepEqual(
        await response.json(),
        authorization.body,
        mutation.name,
      );
      assert.equal(readCount(), 0, `${mutation.name} must authorize first`);
    }
  }
});

test("unknown receiving config errors fail closed without leaking details", () => {
  const secret = "re_unknown_config_detail_must_not_escape";
  const safe = getSafeReceivingAdminError(
    new ReceivingConfigError("RESEND_RECEIVING_FUTURE_ERROR", secret),
  );
  assert.equal(safe.status, 500);
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.deepEqual(safe.body, {
    code: "RESEND_RECEIVING_OPERATION_FAILED",
    error: "Inbound receiving operation failed.",
  });
});

const invalidRequestBody = {
  code: "RESEND_RECEIVING_REQUEST_INVALID",
  error: "Invalid inbound receiving request.",
};

function receivingMutationCases(input: {
  requireOneAdmin: () => Promise<{
    organizationId: string;
    session: { user: { id: string } };
  }>;
  requireDesktopAdmin: () => Promise<{ id: string }>;
}) {
  const organizationId = "organization-route-contract";
  const oneReceivingUrl = "http://localhost/api/organization/email/receiving";
  const desktopReceivingUrl = `http://localhost/api/desktop/v1/organizations/${organizationId}/email/receiving`;
  const desktopContext = {
    params: Promise.resolve({ organizationId }),
  };

  return [
    {
      name: "One receiving PUT",
      url: oneReceivingUrl,
      invoke: (request: Request) =>
        createOneReceivingPutHandler({
          requireAdmin: input.requireOneAdmin,
        })(request),
    },
    {
      name: "One domains POST",
      url: `${oneReceivingUrl}/domains`,
      invoke: (request: Request) =>
        createOneReceivingDomainsPostHandler({
          requireAdmin: input.requireOneAdmin,
        })(request),
    },
    {
      name: "One activation POST",
      url: `${oneReceivingUrl}/activation`,
      invoke: (request: Request) =>
        createOneReceivingActivationPostHandler({
          requireAdmin: input.requireOneAdmin,
        })(request),
    },
    {
      name: "Desktop receiving PUT",
      url: desktopReceivingUrl,
      invoke: (request: Request) =>
        createDesktopReceivingPutHandler({
          requireAdmin: input.requireDesktopAdmin,
        })(request, desktopContext),
    },
    {
      name: "Desktop domains POST",
      url: `${desktopReceivingUrl}/domains`,
      invoke: (request: Request) =>
        createDesktopReceivingDomainsPostHandler({
          requireAdmin: input.requireDesktopAdmin,
        })(request, desktopContext),
    },
  ];
}

function malformedRequest(url: string) {
  return new Request(url, {
    method: url.endsWith("/domains") ? "POST" : "PUT",
    body: "{",
    headers: { "content-type": "application/json" },
  });
}

function trackedMalformedRequest(url: string) {
  const request = malformedRequest(url);
  let reads = 0;
  request.text = async () => {
    reads += 1;
    return "{";
  };
  return { request, readCount: () => reads };
}
