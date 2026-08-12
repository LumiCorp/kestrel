export type SignupAuthority =
  | { kind: "organization_invitation"; value: string }
  | { kind: "signup_code"; value: string };

export function resolveSignupAuthority(input: {
  invitationId?: string | null;
  signupCode?: string | null;
}): SignupAuthority {
  const invitationId = input.invitationId?.trim() || null;
  const signupCode = input.signupCode?.trim() || null;
  if (invitationId && signupCode) {
    throw new Error("Choose one signup method.");
  }
  if (signupCode) return { kind: "signup_code", value: signupCode };
  if (invitationId) {
    return { kind: "organization_invitation", value: invitationId };
  }
  throw new Error(
    "A valid signup code or organization invitation is required.",
  );
}
