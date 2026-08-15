import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import {
  assertProcessConfiguration,
  assertRunPodWorkerProcessConfiguration,
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

const MANAGED_NAME_PATTERN = /^(?:ANTHROPIC|CRON|DATABASE|KESTREL|KV|OPENAI|OPENROUTER|POSTGRES|REDIS|RUNPOD|STORAGE|TAVILY)_/u;
const ROLE_FATAL_FORBIDDEN: Partial<Record<ManagedWorkerRole, readonly string[]>> = {
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
  const removals = existingNames
    .filter(
      (name) =>
        !flyOwned.has(name) &&
        ((MANAGED_HOSTED_RUNTIME_SECRET_NAMES.has(name) && !allowed.has(name)) ||
          (allowed.has(name) && !selectedNames.has(name))),
    )
    .sort();
  return { removals };
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed.`);
  return result.stdout;
}

function runWithInput(command: string, args: string[], input: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed.`);
  return result.stdout;
}

export function serializeWorkerConfiguration(selected: Record<string, string>) {
  return `${Object.entries(selected)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

function secretInventory(value: unknown) {
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

export function assertStagedWorkerSecretInventory(input: {
  selectedNames: string[];
  removalNames: string[];
  inventory: Array<{ name: string; status: string }>;
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

async function main() {
  const roleIndex = process.argv.indexOf("--role");
  const role = process.argv[roleIndex + 1] as ManagedWorkerRole | undefined;
  if (!(role && Object.hasOwn(ROLE_CONFIG, role))) {
    throw new Error(
      "Usage: sync-worker-config --role <turn-worker|control-worker|runpod-worker>",
    );
  }
  const config = ROLE_CONFIG[role];
  const directory = await mkdtemp(
    join(tmpdir(), `kestrel-${role}-${randomUUID()}-`),
  );
  const envFile = join(directory, "production.env");
  try {
    run("vercel", [
      "link",
      "--cwd",
      directory,
      "--project",
      "one",
      "--scope",
      "lumi-kestrel",
      "--yes",
    ]);
    run("vercel", [
      "env",
      "pull",
      envFile,
      "--environment=production",
      "--cwd",
      directory,
      "--yes",
    ]);
    const selected = selectWorkerConfiguration(
      role,
      dotenv.parse(await readFile(envFile, "utf8")),
    );
    const beforeInventory = secretInventory(
      JSON.parse(run("fly", ["secrets", "list", "--app", config.app, "--json"])),
    );
    const existingNames = beforeInventory.map((secret) => secret.name);
    assertFlyOwnedAuthorityPresent(role, existingNames);
    const { removals } = classifyWorkerSecretInventory(
      role,
      existingNames,
      selected,
    );
    runWithInput(
      "fly",
      ["secrets", "import", "--stage", "--app", config.app],
      serializeWorkerConfiguration(selected),
    );
    if (removals.length) {
      run("fly", ["secrets", "unset", "--stage", "--app", config.app, ...removals]);
    }
    assertStagedWorkerSecretInventory({
      selectedNames: Object.keys(selected),
      removalNames: removals,
      inventory: secretInventory(
        JSON.parse(
          run("fly", ["secrets", "list", "--app", config.app, "--json"]),
        ),
      ),
    });
    process.stdout.write(
      `Staged ${role} configuration (${config.fingerprint}); activation requires the image deployment.\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Worker configuration sync failed."}\n`,
    );
    process.exitCode = 1;
  });
}
