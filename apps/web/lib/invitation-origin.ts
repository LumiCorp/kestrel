export type InvitationOriginEnvironment = {
  BETTER_AUTH_URL?: string;
  NEXT_PUBLIC_APP_URL?: string;
  NODE_ENV?: string;
};

export function invitationOrigin(
  env: InvitationOriginEnvironment = process.env,
) {
  const configured = env.BETTER_AUTH_URL?.trim();
  const fallback = env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:43103";

  if (!configured && env.NODE_ENV === "production") {
    throw new Error(
      "BETTER_AUTH_URL must be configured before sending invitations.",
    );
  }

  try {
    const url = new URL(configured || fallback);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Invitation URLs must use HTTP or HTTPS.");
    }
    return url.origin;
  } catch (error) {
    throw new Error(
      error instanceof Error &&
        error.message === "Invitation URLs must use HTTP or HTTPS."
        ? error.message
        : "BETTER_AUTH_URL must be a valid absolute HTTP(S) URL.",
    );
  }
}
