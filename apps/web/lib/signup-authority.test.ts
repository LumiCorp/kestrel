import assert from "node:assert/strict";
import test from "node:test";
import { resolveSignupAuthority } from "./signup-authority";

test("signup accepts exactly one account-creation authority", () => {
  assert.deepEqual(resolveSignupAuthority({ signupCode: "CODE" }), {
    kind: "signup_code",
    value: "CODE",
  });
  assert.deepEqual(resolveSignupAuthority({ invitationId: "invite-1" }), {
    kind: "organization_invitation",
    value: "invite-1",
  });
  assert.throws(() => resolveSignupAuthority({}), /required/u);
  assert.throws(
    () =>
      resolveSignupAuthority({
        invitationId: "invite-1",
        signupCode: "CODE",
      }),
    /one signup method/u,
  );
});
