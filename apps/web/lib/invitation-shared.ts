export const INVITATION_SIGNUP_HEADER = "x-kestrel-invitation-id";

const invitationPathPrefix = "/accept-invitation/";

export function invitationPath(invitationId: string) {
  return `${invitationPathPrefix}${encodeURIComponent(invitationId)}`;
}

export function invitationIdFromCallbackURL(
  callbackURL: string | null | undefined,
) {
  if (!callbackURL?.startsWith(invitationPathPrefix)) {
    return null;
  }

  const encodedId = callbackURL.slice(invitationPathPrefix.length);
  if (
    !encodedId ||
    encodedId.includes("/") ||
    encodedId.includes("?") ||
    encodedId.includes("#")
  ) {
    return null;
  }

  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

export function isInvitationCallbackURL(value: string) {
  return invitationIdFromCallbackURL(value) !== null;
}
