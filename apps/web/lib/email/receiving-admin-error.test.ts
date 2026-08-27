import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { z } from "zod";
import { DesktopUserAuthorizationError } from "@/lib/desktop-account";
import { ReceivingConfigError } from "./receiving-config";
import { getSafeReceivingAdminError } from "./receiving-admin-error";

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
