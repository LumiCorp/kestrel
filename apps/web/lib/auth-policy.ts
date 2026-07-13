export function isDisallowedGithubSignIn(input: {
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
    (input.body as { provider?: unknown }).provider === "github"
  );
}
