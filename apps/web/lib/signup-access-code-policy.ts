import { createHash } from "node:crypto";

const SIGNUP_ACCESS_CODE_PATTERN = /^[A-Z0-9-]{4,64}$/u;

export const SIGNUP_ACCESS_CODE_UNAVAILABLE =
  "SIGNUP_ACCESS_CODE_UNAVAILABLE" as const;

export class SignupAccessCodePolicyError extends Error {
  readonly code = SIGNUP_ACCESS_CODE_UNAVAILABLE;

  constructor() {
    super(signupAccessCodeUnavailableMessage());
    this.name = "SignupAccessCodePolicyError";
  }
}

export function isSignupAccessCodePolicyError(
  error: unknown,
): error is SignupAccessCodePolicyError {
  return (
    error instanceof SignupAccessCodePolicyError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === SIGNUP_ACCESS_CODE_UNAVAILABLE)
  );
}

export function normalizeSignupAccessCode(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function assertValidSignupAccessCode(value: unknown) {
  const normalized = normalizeSignupAccessCode(value);
  if (!SIGNUP_ACCESS_CODE_PATTERN.test(normalized)) {
    throw new Error(
      "Invite codes use 4 to 64 letters, numbers, or hyphens.",
    );
  }
  return normalized;
}

export function hashSignupAccessCode(value: unknown) {
  return createHash("sha256")
    .update(assertValidSignupAccessCode(value))
    .digest("hex");
}

export function signupAccessCodeHint(value: unknown) {
  const normalized = assertValidSignupAccessCode(value);
  return normalized.length <= 8
    ? `${normalized.slice(0, 2)}${"•".repeat(normalized.length - 2)}`
    : `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

export function normalizeSignupEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function signupAccessCodeUnavailableMessage() {
  return "This invite code is invalid or no longer available.";
}

export function signupAccessCodeTemporarilyUnavailableMessage() {
  return "Signup is temporarily unavailable. Please try again.";
}
