import { assertHostedEnvironmentConfiguration } from "../lib/environments/config";

if (
  process.env.KESTREL_ENVIRONMENTS_ENABLED?.trim().toLowerCase() !== "true"
) {
  throw new Error(
    "KESTREL_ENVIRONMENTS_ENABLED must be true for the hosted Environment cutover."
  );
}

assertHostedEnvironmentConfiguration(process.env);

for (const name of [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
] as const) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required for the GitHub OAuth canary.`);
  }
}

const controlPlaneOrigin = new URL(
  process.env.KESTREL_ONE_APP_URL as string
).origin;
for (const name of ["BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL"] as const) {
  const origin = new URL(process.env[name] as string).origin;
  if (origin !== controlPlaneOrigin) {
    throw new Error(
      `${name} must use the same origin as KESTREL_ONE_APP_URL (${controlPlaneOrigin}).`
    );
  }
}

process.stdout.write(
  "Hosted Environment cutover configuration passed. Legacy global runner configuration is absent.\n"
);
