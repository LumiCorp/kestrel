export type InvitationCandidate = {
  id: string;
  email: string;
  status: string;
  expiresAt: Date;
};

export function invitationSignupError(input: {
  invitationId: string | null;
  email: unknown;
  invitation: InvitationCandidate | null;
  now: Date;
}) {
  if (!input.invitationId) {
    return "A valid organization invitation is required to create an account.";
  }
  if (
    !input.invitation ||
    input.invitation.status !== "pending" ||
    input.invitation.expiresAt.getTime() <= input.now.getTime()
  ) {
    return "This organization invitation is no longer available.";
  }
  if (normalizeEmail(input.invitation.email) !== normalizeEmail(input.email)) {
    return "Create the account with the email address that received this invitation.";
  }
  return null;
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
