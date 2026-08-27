import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { z } from "zod";
import { DesktopUserAuthorizationError } from "@/lib/desktop-account";
import { ReceivingConfigError } from "./receiving-config";
import {
  getSafeReceivingAdminError,
  parseReceivingAdminJson,
} from "./receiving-admin-error";

const receivingRoutes = [
  "../../app/api/organization/email/receiving/route.ts",
  "../../app/api/organization/email/receiving/domains/route.ts",
  "../../app/api/desktop/v1/organizations/[organizationId]/email/receiving/route.ts",
  "../../app/api/desktop/v1/organizations/[organizationId]/email/receiving/domains/route.ts",
].map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8"));

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

test("One and Desktop receiving routes use the same safe status boundary", () => {
  for (const route of receivingRoutes) {
    assert.match(route, /getSafeReceivingAdminError/u);
  }
});

test("One records the receiving update audit only after the save succeeds", () => {
  const oneReceivingRoute = receivingRoutes[0];
  assert.ok(oneReceivingRoute);
  const save = oneReceivingRoute.indexOf(
    "const connection = await saveReceivingConnection",
  );
  const audit = oneReceivingRoute.indexOf("await logAdminEvent", save);
  const success = oneReceivingRoute.indexOf(
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

test("all four receiving mutations authorize before using the shared JSON parser", () => {
  for (const route of receivingRoutes) {
    assert.equal(
      route.match(/parseReceivingAdminJson\(request\)/gu)?.length,
      1,
    );
    const authorizationOffset = Math.max(
      route.indexOf("await requireOrganizationAdmin()"),
      route.indexOf("await requireDesktopReceivingAdmin(request, organizationId)"),
    );
    const parsingOffset = route.indexOf("parseReceivingAdminJson(request)");
    assert.ok(authorizationOffset >= 0);
    assert.ok(parsingOffset > authorizationOffset);
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
