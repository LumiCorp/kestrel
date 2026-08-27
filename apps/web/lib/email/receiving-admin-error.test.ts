import assert from "node:assert/strict";
import test from "node:test";
import { DesktopUserAuthorizationError } from "@/lib/desktop-account";
import { getSafeReceivingAdminError } from "./receiving-admin-error";

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
