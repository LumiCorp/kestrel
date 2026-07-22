const LINKED_TOOL_PROVIDERS = new Set([
  "github",
  "google",
  "microsoft-entra-id",
]);

export function isDisallowedToolProviderSignIn(input: {
  path: string;
  body: unknown;
}) {
  if (input.path !== "/sign-in/social" && input.path !== "/sign-in/oauth2") {
    return false;
  }
  if (!(input.body && typeof input.body === "object")) {
    return false;
  }
  return (
    (("provider" in input.body &&
      typeof (input.body as { provider?: unknown }).provider === "string" &&
      LINKED_TOOL_PROVIDERS.has(
        (input.body as { provider: string }).provider
      )) ||
      ("providerId" in input.body &&
        typeof (input.body as { providerId?: unknown }).providerId ===
          "string" &&
        LINKED_TOOL_PROVIDERS.has(
          (input.body as { providerId: string }).providerId
        )))
  );
}

export const isDisallowedGithubSignIn = isDisallowedToolProviderSignIn;
