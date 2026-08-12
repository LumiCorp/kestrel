import assert from "node:assert/strict";
import test from "node:test";
import {
  assertValidSignupAccessCode,
  hashSignupAccessCode,
  isSignupAccessCodePolicyError,
  normalizeSignupAccessCode,
  SignupAccessCodePolicyError,
  signupAccessCodeHint,
  signupAccessCodeTemporarilyUnavailableMessage,
  signupAccessCodeUnavailableMessage,
} from "./signup-access-code-policy";

test("signup codes normalize with trim and uppercase", () => {
  assert.equal(
    normalizeSignupAccessCode("  build-with-kestrel  "),
    "BUILD-WITH-KESTREL",
  );
  assert.equal(assertValidSignupAccessCode(" beta-2 "), "BETA-2");
});

test("signup codes reject values outside the public alphabet and length", () => {
  for (const value of [
    "ABC",
    "contains space",
    "under_score",
    "x".repeat(65),
  ]) {
    assert.throws(() => assertValidSignupAccessCode(value));
  }
});

test("signup code hashing is normalized and hints do not reveal long codes", () => {
  assert.equal(
    hashSignupAccessCode(" beta-2 "),
    hashSignupAccessCode("BETA-2"),
  );
  assert.equal(signupAccessCodeHint("BETA-2"), "BE••••");
  assert.equal(signupAccessCodeHint("BUILDWITHKESTREL"), "BUIL…TREL");
  assert.equal(
    signupAccessCodeUnavailableMessage(),
    "This invite code is invalid or no longer available.",
  );
});

test("signup code policy failures have generic public messages", () => {
  const error = new SignupAccessCodePolicyError();
  assert.equal(isSignupAccessCodePolicyError(error), true);
  assert.equal(error.message, signupAccessCodeUnavailableMessage());
  assert.equal(
    signupAccessCodeTemporarilyUnavailableMessage(),
    "Signup is temporarily unavailable. Please try again.",
  );
  assert.equal(isSignupAccessCodePolicyError(new Error("database detail")), false);
});
