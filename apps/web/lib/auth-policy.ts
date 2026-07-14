const LINKED_TOOL_PROVIDERS = new Set(["github", "google"]);

export function isDisallowedToolProviderSignIn(input: {
  path: string;
  body: unknown;
}) {
  if (input.path !== "/sign-in/social") {
    return false;
  }
  if (!(input.body && typeof input.body === "object")) {
    return false;
  }
  return (
    "provider" in input.body &&
    typeof (input.body as { provider?: unknown }).provider === "string" &&
    LINKED_TOOL_PROVIDERS.has(
      (input.body as { provider: string }).provider
    )
  );
}

export const isDisallowedGithubSignIn = isDisallowedToolProviderSignIn;
