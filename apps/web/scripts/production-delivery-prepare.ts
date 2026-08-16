import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import {
  assertProcessConfiguration,
  assertRunPodWorkerProcessConfiguration,
  assertWebProcessConfiguration,
  CONTROL_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  CONTROL_WORKER_PROCESS_CONTRACT,
  MANAGED_HOSTED_RUNTIME_SECRET_NAMES,
  processContractAllowedNames,
  RUNPOD_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  RUNPOD_WORKER_PROCESS_CONTRACT,
  TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  TURN_WORKER_PROCESS_CONTRACT,
  type ProcessContract,
} from "@/lib/runtime/process-contracts";

export type ManagedWorkerRole =
  | "turn-worker"
  | "control-worker"
  | "runpod-worker";

type SecretInventoryItem = { name: string; status: string };
type CommandRunner = {
  run(command: string, args: string[]): string;
  runWithInput(command: string, args: string[], input: string): string;
};

const ROLES = ["turn-worker", "control-worker", "runpod-worker"] as const;
const LEGACY_WEB_IMAGE_NAMES = [
  "KESTREL_ENVIRONMENT_ROUTER_IMAGE",
  "KESTREL_WORKSPACE_RUNTIME_IMAGE",
] as const;
const MANAGED_NAME_PATTERN =
  /^(?:ANTHROPIC|CRON|DATABASE|KESTREL|KV|OPENAI|OPENROUTER|POSTGRES|REDIS|RUNPOD|STORAGE|TAVILY)_/u;

const ROLE_CONFIG: Record<
  ManagedWorkerRole,
  {
    app: string;
    contract: ProcessContract;
    fingerprint: string;
    flyOwned: readonly string[];
  }
> = {
  "turn-worker": {
    app: "kestrel-one-turn-worker",
    contract: TURN_WORKER_PROCESS_CONTRACT,
    fingerprint: TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
    flyOwned: [],
  },
  "control-worker": {
    app: "kestrel-one-control-worker",
    contract: CONTROL_WORKER_PROCESS_CONTRACT,
    fingerprint: CONTROL_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
    flyOwned: ["FLY_API_TOKEN", "KESTREL_FLY_ORGANIZATION_SLUG"],
  },
  "runpod-worker": {
    app: "kestrel-one-runpod-worker",
    contract: RUNPOD_WORKER_PROCESS_CONTRACT,
    fingerprint: RUNPOD_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
    flyOwned: [],
  },
};

const ROLE_FATAL_FORBIDDEN: Partial<
  Record<ManagedWorkerRole, readonly string[]>
> = {
  "runpod-worker": ["RUNPOD_API_KEY"],
};

export function selectWorkerConfiguration(
  role: ManagedWorkerRole,
  source: Record<string, string>,
) {
  const config = ROLE_CONFIG[role];
  const allowed = processContractAllowedNames(config.contract);
  const flyOwned = new Set(config.flyOwned);
  const selected: Record<string, string> = {};
  const forbidden = (ROLE_FATAL_FORBIDDEN[role] ?? []).filter((name) =>
    Boolean(source[name]?.trim()),
  );
  if (forbidden.length) {
    throw new Error(
      `${role} configuration contains forbidden provider authority: ${forbidden.join(", ")}.`,
    );
  }
  for (const name of allowed) {
    if (flyOwned.has(name)) continue;
    const value = source[name]?.trim();
    if (value) selected[name] = value;
  }
  const validationEnvironment = { ...selected };
  for (const name of flyOwned) validationEnvironment[name] = "fly-owned";
  assertProcessConfiguration(config.contract, validationEnvironment);
  if (role === "runpod-worker") {
    assertRunPodWorkerProcessConfiguration(validationEnvironment);
  }
  return selected;
}

export function classifyWorkerSecretInventory(
  role: ManagedWorkerRole,
  existingNames: string[],
  selected: Record<string, string>,
) {
  const config = ROLE_CONFIG[role];
  const allowed = processContractAllowedNames(config.contract);
  const flyOwned = new Set(config.flyOwned);
  const selectedNames = new Set(Object.keys(selected));
  const forbidden = existingNames.filter((name) =>
    (ROLE_FATAL_FORBIDDEN[role] ?? []).includes(name),
  );
  if (forbidden.length) {
    throw new Error(
      `${role} has forbidden provider authority: ${forbidden.sort().join(", ")}.`,
    );
  }
  const unknown = existingNames.filter(
    (name) =>
      MANAGED_NAME_PATTERN.test(name) &&
      !MANAGED_HOSTED_RUNTIME_SECRET_NAMES.has(name) &&
      !flyOwned.has(name),
  );
  if (unknown.length) {
    throw new Error(
      `${role} has unknown managed secrets: ${unknown.sort().join(", ")}.`,
    );
  }
  return {
    removals: existingNames
      .filter(
        (name) =>
          !flyOwned.has(name) &&
          ((MANAGED_HOSTED_RUNTIME_SECRET_NAMES.has(name) &&
            !allowed.has(name)) ||
            (allowed.has(name) && !selectedNames.has(name))),
      )
      .sort(),
  };
}

export function assertFlyOwnedAuthorityPresent(
  role: ManagedWorkerRole,
  existingNames: string[],
) {
  const missing = ROLE_CONFIG[role].flyOwned.filter(
    (name) => !existingNames.includes(name),
  );
  if (missing.length) {
    throw new Error(
      `${role} is missing Fly-owned authority: ${missing.join(", ")}.`,
    );
  }
}

export function serializeWorkerConfiguration(selected: Record<string, string>) {
  return `${Object.entries(selected)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

export function assertStagedWorkerSecretInventory(input: {
  selectedNames: string[];
  removalNames: string[];
  inventory: SecretInventoryItem[];
}) {
  const pending = (status: string) => /staged|pending/iu.test(status);
  const notStaged = input.selectedNames.filter(
    (name) =>
      !input.inventory.some(
        (secret) => secret.name === name && pending(secret.status),
      ),
  );
  const removalsNotStaged = input.removalNames.filter((name) => {
    const secret = input.inventory.find((candidate) => candidate.name === name);
    return secret ? !pending(secret.status) : false;
  });
  if (notStaged.length || removalsNotStaged.length) {
    throw new Error(
      `Worker secret staging is incomplete (not staged: ${notStaged.join(", ") || "none"}; removals not staged: ${removalsNotStaged.join(", ") || "none"}).`,
    );
  }
}

export function assertPreparationDatabaseState(input: {
  migrationApplied: boolean;
  canaryEnvironmentId: string | null;
  canaryReady: boolean;
  activeReleaseCount: number;
  nonterminalTargetCount: number;
  queuedReleaseJobCount: number;
  activeCanaryOperations: Array<{
    id: string;
    type: string;
    status: string;
    stage: string;
  }>;
}) {
  if (input.migrationApplied) {
    throw new Error(
      "Production preparation is unavailable after migration 0073 is live.",
    );
  }
  const releaseBlockers = [
    ["active releases", input.activeReleaseCount],
    ["nonterminal release targets", input.nonterminalTargetCount],
    ["queued release jobs", input.queuedReleaseJobCount],
  ] as const;
  const presentReleaseBlockers = releaseBlockers.filter(([, count]) => count);
  if (presentReleaseBlockers.length) {
    throw new Error(
      `Production preparation is blocked by ${presentReleaseBlockers
        .map(([name, count]) => `${name}=${count}`)
        .join(", ")}.`,
    );
  }
  if (!input.canaryEnvironmentId) {
    throw new Error("Production preparation has no configured canary Environment.");
  }
  if (!input.canaryReady) {
    throw new Error(
      `Production canary ${input.canaryEnvironmentId} is not ready.`,
    );
  }
  const blockingCanaryOperations = input.activeCanaryOperations.filter(
    (operation) => operation.type !== "workspace.backup",
  );
  if (blockingCanaryOperations.length) {
    throw new Error(
      `Production canary has blocking lifecycle operations: ${blockingCanaryOperations
        .map(
          (operation) =>
            `${operation.id} (${operation.type}, ${operation.status}, ${operation.stage})`,
        )
        .join("; ")}.`,
    );
  }
  return {
    allowedBackupOperations: input.activeCanaryOperations.filter(
      (operation) => operation.type === "workspace.backup",
    ),
  };
}

export function assertProductionBranchPolicy(value: unknown) {
  const policies =
    value && typeof value === "object" && "branch_policies" in value
      ? (value as { branch_policies?: unknown }).branch_policies
      : undefined;
  const names = Array.isArray(policies)
    ? policies.flatMap((policy) => {
        if (!(policy && typeof policy === "object" && "name" in policy)) {
          return [];
        }
        return typeof policy.name === "string" ? [policy.name] : [];
      })
    : [];
  if (names.length !== 1 || names[0] !== "production") {
    throw new Error(
      `GitHub Production environment must allow only the production branch; found ${names.join(", ") || "none"}.`,
    );
  }
}

export function requireProductionDatabaseUrl(
  source: Record<string, string>,
) {
  const databaseUrl =
    source.POSTGRES_URL_NON_POOLING?.trim() ||
    source.DATABASE_URL_UNPOOLED?.trim();
  if (!databaseUrl) {
    throw new Error(
      "Vercel Production requires POSTGRES_URL_NON_POOLING or DATABASE_URL_UNPOOLED.",
    );
  }
  return databaseUrl;
}

export function assertProspectiveWebConfiguration(
  source: Record<string, string>,
) {
  const prospective: Record<string, string> = {
    ...source,
    PRODUCTION_IMAGE_DEPLOY_TOKEN:
      source.PRODUCTION_IMAGE_DEPLOY_TOKEN?.trim() || "pending-installation",
  };
  for (const name of LEGACY_WEB_IMAGE_NAMES) delete prospective[name];
  assertWebProcessConfiguration(prospective);
}

function secretInventory(value: unknown): SecretInventoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!(item && typeof item === "object")) return [];
    const record = item as Record<string, unknown>;
    const name = record.Name ?? record.name;
    const status =
      record.DeploymentStatus ??
      record.deploymentStatus ??
      record.Status ??
      record.status;
    return typeof name === "string"
      ? [{ name, status: typeof status === "string" ? status : "" }]
      : [];
  });
}

function createCommandRunner(): CommandRunner {
  const execute = (command: string, args: string[], input?: string) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(`${command} ${args[0] ?? ""} failed.`);
    }
    return result.stdout;
  };
  return {
    run: (command, args) => execute(command, args),
    runWithInput: (command, args, input) => execute(command, args, input),
  };
}

async function readPreparationDatabaseState(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [state] = await sql<
      Array<{
        migrationApplied: boolean;
        canaryEnvironmentId: string | null;
        canaryReady: boolean;
        activeReleaseCount: number;
        nonterminalTargetCount: number;
        queuedReleaseJobCount: number;
      }>
    >`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'environment_runtime_channels'
            AND column_name = 'desired_version_id'
        ) AS "migrationApplied",
        channel."canary_environment_id" AS "canaryEnvironmentId",
        EXISTS (
          SELECT 1 FROM "environments" environment
          WHERE environment."id" = channel."canary_environment_id"
            AND environment."provider" = 'fly'
            AND environment."archived_at" IS NULL
            AND environment."status" IN ('ready', 'degraded')
        ) AS "canaryReady",
        (SELECT count(*)::int FROM "fly_image_releases"
          WHERE "status" IN ('approved', 'deploying', 'paused'))
          AS "activeReleaseCount",
        (SELECT count(*)::int
          FROM "fly_image_release_targets" target
          JOIN "fly_image_releases" release ON release."id" = target."release_id"
          WHERE target."status" NOT IN ('completed', 'failed')
            AND release."status" NOT IN ('completed', 'superseded'))
          AS "nonterminalTargetCount",
        (SELECT count(*)::int FROM pgboss.job
          WHERE name LIKE 'fly-image.release%'
            AND state IN ('created', 'retry', 'active'))
          AS "queuedReleaseJobCount"
      FROM "environment_runtime_channels" channel
      WHERE channel."name" = 'production'
    `;
    if (!state) throw new Error("Production runtime channel is unavailable.");
    const activeCanaryOperations = await sql<
      Array<{ id: string; type: string; status: string; stage: string }>
    >`
      SELECT "id", "type", "status", "stage"
      FROM "environment_operations"
      WHERE "environment_id" = ${state.canaryEnvironmentId}
        AND "status" IN ('queued', 'running')
      ORDER BY "created_at", "id"
    `;
    return { ...state, activeCanaryOperations };
  } finally {
    await sql.end({ timeout: 0 });
  }
}

export async function prepareProductionDelivery(input: {
  apply: boolean;
  runner?: CommandRunner;
}) {
  const runner = input.runner ?? createCommandRunner();
  const directory = await mkdtemp(
    join(tmpdir(), `kestrel-production-delivery-${randomUUID()}-`),
  );
  const envFile = join(directory, "production.env");
  try {
    runner.run("vercel", [
      "link",
      "--cwd",
      directory,
      "--project",
      "one",
      "--scope",
      "lumi-kestrel",
      "--yes",
    ]);
    runner.run("vercel", [
      "env",
      "pull",
      envFile,
      "--environment=production",
      "--cwd",
      directory,
      "--yes",
    ]);
    const source = dotenv.parse(await readFile(envFile, "utf8"));
    const databaseUrl = requireProductionDatabaseUrl(source);
    assertProspectiveWebConfiguration(source);
    assertProductionBranchPolicy(
      JSON.parse(
        runner.run("gh", [
          "api",
          "repos/LumiCorp/kestrel/environments/Production/deployment-branch-policies",
        ]),
      ),
    );
    const databasePreparation = assertPreparationDatabaseState(
      await readPreparationDatabaseState(databaseUrl),
    );
    if (databasePreparation.allowedBackupOperations.length) {
      process.stdout.write(
        `Production canary has ${databasePreparation.allowedBackupOperations.length} active backup operation(s); the repaired lifecycle worker will drain them before runtime reconciliation.\n`,
      );
    }

    const rolePlans = ROLES.map((role) => {
      const config = ROLE_CONFIG[role];
      const selected = selectWorkerConfiguration(role, source);
      const inventory = secretInventory(
        JSON.parse(
          runner.run("fly", [
            "secrets",
            "list",
            "--app",
            config.app,
            "--json",
          ]),
        ),
      );
      const existingNames = inventory.map((secret) => secret.name);
      assertFlyOwnedAuthorityPresent(role, existingNames);
      return {
        role,
        config,
        selected,
        removals: classifyWorkerSecretInventory(
          role,
          existingNames,
          selected,
        ).removals,
      };
    });

    if (!input.apply) {
      process.stdout.write(
        `Production delivery preparation check passed. Apply would stage ${rolePlans.length} worker roles, install PRODUCTION_IMAGE_DEPLOY_TOKEN, and remove ${LEGACY_WEB_IMAGE_NAMES.join(", ")}.\n`,
      );
      return;
    }

    const token = randomBytes(32).toString("base64url");
    for (const plan of rolePlans) {
      runner.runWithInput(
        "fly",
        ["secrets", "import", "--stage", "--app", plan.config.app],
        serializeWorkerConfiguration(plan.selected),
      );
      if (plan.removals.length) {
        runner.run("fly", [
          "secrets",
          "unset",
          "--stage",
          "--app",
          plan.config.app,
          ...plan.removals,
        ]);
      }
      assertStagedWorkerSecretInventory({
        selectedNames: Object.keys(plan.selected),
        removalNames: plan.removals,
        inventory: secretInventory(
          JSON.parse(
            runner.run("fly", [
              "secrets",
              "list",
              "--app",
              plan.config.app,
              "--json",
            ]),
          ),
        ),
      });
      process.stdout.write(
        `Staged ${plan.role} configuration (${plan.config.fingerprint}).\n`,
      );
    }

    runner.runWithInput(
      "vercel",
      [
        "env",
        "add",
        "PRODUCTION_IMAGE_DEPLOY_TOKEN",
        "production",
        "--sensitive",
        "--force",
        "--cwd",
        directory,
        "--yes",
      ],
      token,
    );
    for (const name of LEGACY_WEB_IMAGE_NAMES) {
      if (source[name]?.trim()) {
        runner.run("vercel", [
          "env",
          "remove",
          name,
          "production",
          "--cwd",
          directory,
          "--yes",
        ]);
      }
    }
    runner.runWithInput(
      "gh",
      [
        "secret",
        "set",
        "PRODUCTION_IMAGE_DEPLOY_TOKEN",
        "--repo",
        "LumiCorp/kestrel",
        "--env",
        "Production",
      ],
      token,
    );
    const githubSecretNames = JSON.parse(
      runner.run("gh", [
        "secret",
        "list",
        "--repo",
        "LumiCorp/kestrel",
        "--env",
        "Production",
        "--json",
        "name",
      ]),
    ) as Array<{ name?: unknown }>;
    if (
      !githubSecretNames.some(
        (secret) => secret.name === "PRODUCTION_IMAGE_DEPLOY_TOKEN",
      )
    ) {
      throw new Error("GitHub production delivery token verification failed.");
    }
    runner.run("vercel", [
      "env",
      "pull",
      envFile,
      "--environment=production",
      "--cwd",
      directory,
      "--yes",
    ]);
    const verifiedWebConfiguration = dotenv.parse(
      await readFile(envFile, "utf8"),
    );
    if (!verifiedWebConfiguration.PRODUCTION_IMAGE_DEPLOY_TOKEN?.trim()) {
      throw new Error("Vercel production delivery token verification failed.");
    }
    const remainingLegacyNames = LEGACY_WEB_IMAGE_NAMES.filter((name) =>
      Boolean(verifiedWebConfiguration[name]?.trim()),
    );
    if (remainingLegacyNames.length) {
      throw new Error(
        `Vercel legacy image removal verification failed: ${remainingLegacyNames.join(", ")}.`,
      );
    }
    assertWebProcessConfiguration(verifiedWebConfiguration);
    process.stdout.write(
      "Production delivery configuration is prepared; no image was deployed.\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const unknown = process.argv
    .slice(2)
    .filter((argument) => argument !== "--apply");
  if (unknown.length) {
    throw new Error("Usage: production-delivery:prepare [--apply]");
  }
  await prepareProductionDelivery({
    apply: process.argv.includes("--apply"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Production preparation failed."}\n`,
    );
    process.exitCode = 1;
  });
}
