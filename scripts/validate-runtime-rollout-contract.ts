import { readFile } from "node:fs/promises";
import { z } from "zod";
import { runtimeRolloutContractSchema } from "../apps/web/lib/runtime-deployments/contracts.js";

const compatibilitySchema = z.object({
  version: z.literal(1),
  environmentRouter: compatibilityEntrySchema(),
  workspaceRuntime: compatibilityEntrySchema(),
});

async function main() {
  const [rolloutRaw, compatibilityRaw, routerSource, runtimeSource] =
    await Promise.all([
      readFile("deploy/fly/runtime-rollout.json", "utf8"),
      readFile("deploy/fly/runtime-compatibility.json", "utf8"),
      readFile("apps/environment-router/src/server.ts", "utf8"),
      readFile("apps/workspace-runtime/src/server.ts", "utf8"),
    ]);
  const rollout = runtimeRolloutContractSchema.parse(JSON.parse(rolloutRaw));
  const compatibility = compatibilitySchema.parse(
    JSON.parse(compatibilityRaw),
  );
  const routerRevision = readRevision(
    routerSource,
    "ENVIRONMENT_GATEWAY_CONTRACT_REVISION",
  );
  const runtimeRevision = readRevision(
    runtimeSource,
    "WORKSPACE_RUNTIME_CONTRACT_REVISION",
  );
  assertCompatibility("Environment router", routerRevision, compatibility.environmentRouter);
  assertCompatibility("Workspace Runtime", runtimeRevision, compatibility.workspaceRuntime);
  if (
    rollout.mode === "rolling" &&
    rollout.workspaceDataMigrationRevision !== null
  ) {
    throw new Error("Rolling mode cannot declare a Workspace data migration.");
  }
  process.stdout.write(
    `Runtime rollout contract passed (${rollout.mode}; router ${routerRevision}; Workspace ${runtimeRevision}).\n`,
  );
}

function compatibilityEntrySchema() {
  return z.object({
    current: z.number().int().positive(),
    supported: z.array(z.number().int().positive()).min(2),
  });
}

function readRevision(source: string, constant: string) {
  const revision = source.match(
    new RegExp(`const ${constant} = (\\d+);`, "u"),
  )?.[1];
  if (!revision) throw new Error(`${constant} is unavailable.`);
  return Number.parseInt(revision, 10);
}

function assertCompatibility(
  label: string,
  sourceRevision: number,
  compatibility: { current: number; supported: number[] },
) {
  if (compatibility.current !== sourceRevision) {
    throw new Error(`${label} compatibility current revision is stale.`);
  }
  for (const revision of [sourceRevision - 1, sourceRevision]) {
    if (!compatibility.supported.includes(revision)) {
      throw new Error(`${label} must support contract revision ${revision}.`);
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime rollout contract validation failed."}\n`,
  );
  process.exit(1);
});
