import { spawnSync } from "node:child_process";
import { getHostedEnvironmentBuildPreflightPhase } from "../lib/environments/config";

const phase = getHostedEnvironmentBuildPreflightPhase();
if (phase === null) {
  process.stdout.write(
    "Hosted Environment build preflight skipped outside a production deployment.\n"
  );
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/hosted-environment-preflight.ts",
    ...(phase === "prepare" ? ["--prepare"] : []),
    "--json",
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  }
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Hosted Environment ${phase} build preflight failed with status ${result.status ?? "unknown"}.`
  );
}
