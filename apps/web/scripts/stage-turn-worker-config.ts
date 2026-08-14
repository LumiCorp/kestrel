import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import postgres from "postgres";
import {
  assertTurnWorkerProcessConfiguration,
  MANAGED_HOSTED_RUNTIME_SECRET_NAMES,
  processContractAllowedNames,
  TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT,
  TURN_WORKER_PROCESS_CONTRACT,
} from "@/lib/runtime/process-contracts";

const app =
  process.env.KESTREL_TURN_WORKER_APP?.trim() || "kestrel-one-turn-worker";
const vercelProject = "one";
const vercelScope = "lumi-kestrel";

export const TURN_WORKER_KNOWN_REMOVALS = [
  "CRON_SECRET",
  "FLY_API_TOKEN",
  "KESTREL_ENVIRONMENT_ROUTER_IMAGE",
  "KESTREL_FLY_ORGANIZATION_SLUG",
  "KESTREL_WORKSPACE_BACKUP_KEY",
  "KESTREL_WORKSPACE_BACKUP_KEY_ID",
  "KESTREL_WORKSPACE_RUNTIME_IMAGE",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_BUCKET",
  "STORAGE_ENDPOINT",
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_KEY_PREFIX",
  "STORAGE_PROVIDER",
  "STORAGE_REGION",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed.`);
  }
  return result.stdout;
}

export function selectTurnWorkerSecrets(source: Record<string, string>) {
  const allowed = processContractAllowedNames(TURN_WORKER_PROCESS_CONTRACT);
  const selected: Record<string, string> = {};
  for (const name of allowed) {
    const value = source[name]?.trim();
    if (value) selected[name] = value;
  }
  assertTurnWorkerProcessConfiguration(selected);
  return selected;
}

export function assertNoUnknownManagedTurnWorkerSecrets(names: string[]) {
  const allowed = processContractAllowedNames(TURN_WORKER_PROCESS_CONTRACT);
  const removals = new Set<string>(TURN_WORKER_KNOWN_REMOVALS);
  const unknown = names.filter(
    (name) =>
      MANAGED_HOSTED_RUNTIME_SECRET_NAMES.has(name) &&
      !allowed.has(name) &&
      !removals.has(name),
  );
  if (unknown.length) {
    throw new Error(
      `Turn-worker staging found unknown managed secrets: ${unknown.sort().join(", ")}.`,
    );
  }
}

export function turnWorkerSecretSetArgs(selected: Record<string, string>) {
  return [
    "secrets",
    "set",
    "--stage",
    "--app",
    app,
    ...Object.entries(selected).map(([name, value]) => `${name}=${value}`),
  ];
}

export function turnWorkerSecretRemovalNames(
  existingNames: string[],
  selected: Record<string, string>,
) {
  const allowed = processContractAllowedNames(TURN_WORKER_PROCESS_CONTRACT);
  const selectedNames = new Set(Object.keys(selected));
  const knownRemovals = new Set<string>(TURN_WORKER_KNOWN_REMOVALS);
  return existingNames
    .filter(
      (name) =>
        knownRemovals.has(name) ||
        (allowed.has(name) && !selectedNames.has(name)),
    )
    .sort();
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

async function assertReleaseFingerprint(
  databaseUrl: string,
  releaseId: string,
) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [component] = await sql<
      Array<{ fingerprint: string | null; status: string }>
    >`
      SELECT
        component.configuration_contract_fingerprint AS fingerprint,
        release.status
      FROM fly_image_releases release
      JOIN fly_image_release_components component
        ON component.release_id = release.id
      WHERE release.id = ${releaseId}
        AND component.role = 'turn-worker'
    `;
    if (!component || component.status !== "candidate") {
      throw new Error("Turn-worker configuration may only be staged for a candidate release.");
    }
    if (
      component.fingerprint !== TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT
    ) {
      throw new Error(
        "Candidate turn-worker configuration fingerprint does not match this checkout.",
      );
    }
  } finally {
    await sql.end({ timeout: 0 });
  }
}

async function main() {
  const releaseIndex = process.argv.indexOf("--release");
  const releaseId = process.argv[releaseIndex + 1];
  if (!(releaseIndex >= 0 && releaseId)) {
    throw new Error("Usage: stage:turn-worker-config -- --release <release-id>");
  }
  const directory = await mkdtemp(
    join(tmpdir(), `kestrel-turn-worker-${randomUUID()}-`),
  );
  const envFile = join(directory, "production.env");
  try {
    run("vercel", [
      "link",
      "--cwd",
      directory,
      "--project",
      vercelProject,
      "--scope",
      vercelScope,
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
    const source = dotenv.parse(await readFile(envFile, "utf8"));
    const selected = selectTurnWorkerSecrets(source);
    const databaseUrl = selected.POSTGRES_URL ?? selected.DATABASE_URL;
    if (!databaseUrl) throw new Error("Production database URL is unavailable.");
    await assertReleaseFingerprint(databaseUrl, releaseId);

    const before = JSON.parse(
      run("fly", ["secrets", "list", "--app", app, "--json"]),
    ) as unknown;
    const beforeNames = secretInventory(before).map((secret) => secret.name);
    assertNoUnknownManagedTurnWorkerSecrets(beforeNames);
    run("fly", turnWorkerSecretSetArgs(selected));
    const removals = turnWorkerSecretRemovalNames(beforeNames, selected);
    if (removals.length) {
      run("fly", ["secrets", "unset", "--stage", "--app", app, ...removals]);
    }
    const after = secretInventory(
      JSON.parse(run("fly", ["secrets", "list", "--app", app, "--json"])) as unknown,
    );
    const stagedNames = Object.keys(selected).filter(
      (name) =>
        !after.some(
          (secret) =>
            secret.name === name && /staged|pending/iu.test(secret.status),
        ),
    );
    const unstagedRemovals = removals.filter((name) => {
      const secret = after.find((candidate) => candidate.name === name);
      return secret && !/staged|pending/iu.test(secret.status);
    });
    if (stagedNames.length || unstagedRemovals.length) {
      throw new Error(
        `Staged turn-worker secret inventory is inconsistent (not staged: ${stagedNames.join(", ") || "none"}; removals not staged: ${unstagedRemovals.join(", ") || "none"}).`,
      );
    }
    process.stdout.write(
      `Staged turn-worker configuration for release ${releaseId} (${TURN_WORKER_CONFIGURATION_CONTRACT_FINGERPRINT}).\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Turn-worker configuration staging failed."}\n`,
    );
    process.exitCode = 1;
  });
}
