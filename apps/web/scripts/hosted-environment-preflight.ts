import { assertHostedEnvironmentConfiguration } from "../lib/environments/config";
import { inspectHostedEnvironmentCutoverReadiness } from "../lib/environments/cutover-readiness";

async function main() {
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

  const databaseUrl = (
    process.env.POSTGRES_URL ?? process.env.DATABASE_URL
  )?.trim();
  if (!databaseUrl) {
    throw new Error(
      "POSTGRES_URL or DATABASE_URL is required for the hosted Environment cutover inspection."
    );
  }

  const readiness = await inspectHostedEnvironmentCutoverReadiness({
    databaseUrl,
  });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
  }
  if (!readiness.ready) {
    throw new Error(
      `Hosted Environment cutover is not ready:\n- ${readiness.blockers.join("\n- ")}`
    );
  }

  if (!process.argv.includes("--json")) {
    process.stdout.write(
      [
        "Hosted Environment cutover passed.",
        "Legacy global runner configuration is absent.",
        `${readiness.snapshot.enabledOrganizationCount} organization(s) are enabled.`,
        `${readiness.snapshot.boundThreadCount}/${readiness.snapshot.enabledOrganizationThreadCount} Thread(s) are already bound; the remainder will bind lazily without changing identity.`,
        `${readiness.snapshot.terminalExecutionCount} terminal Environment execution(s) are recorded.`,
      ].join("\n") + "\n"
    );
  }
}

void main();
