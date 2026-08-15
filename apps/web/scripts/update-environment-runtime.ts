import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";

async function main() {
  const actorUserId = argument("--actor-user-id");
  const versionId = argument("--version");
  const environmentId = optionalArgument("--environment");
  const batch = process.argv.includes("--batch");
  if (!actorUserId || !versionId || (batch === Boolean(environmentId))) {
    throw new Error(
      "Usage: update-environment-runtime --actor-user-id <id> --version <id> (--environment <id> | --batch --canary-operation <id>)",
    );
  }
  const directory = await mkdtemp(
    join(tmpdir(), `kestrel-runtime-update-${randomUUID()}-`),
  );
  try {
    await loadProductionEnvironment(directory);
    const [{ knowledgeDb, schema }, runtime, queue] = await Promise.all([
      import("@/lib/knowledge/db"),
      import("@/lib/environments/runtime-channel"),
      import("@/lib/knowledge/queue"),
    ]);
    const actor = await knowledgeDb.query.users.findFirst({
      where: eq(schema.users.id, actorUserId),
      columns: { id: true },
    });
    if (!actor) throw new Error("The audit actor user does not exist.");

    if (environmentId) {
      const environment = await knowledgeDb.query.environments.findFirst({
        where: eq(schema.environments.id, environmentId),
        columns: { organizationId: true },
      });
      if (!environment) throw new Error("Environment not found.");
      const requested = await runtime.requestEnvironmentRuntimeUpdate({
        organizationId: environment.organizationId,
        environmentId,
        runtimeVersionId: versionId,
        actorUserId,
      });
      if (requested.operation.status === "queued") {
        await queue.enqueueEnvironmentOperation(requested.operation.id);
      }
      process.stdout.write(`Environment update operation ${requested.operation.id}.\n`);
      return;
    }

    const canaryOperationId = argument("--canary-operation");
    if (!canaryOperationId) throw new Error("Batch mode requires --canary-operation.");
    const channel = await runtime.getEnvironmentRuntimeChannel();
    if (channel.currentVersion?.id !== versionId) {
      throw new Error("Batch mode requires the requested version to remain current.");
    }
    const canaryOperation = await knowledgeDb.query.environmentOperations.findFirst({
      where: and(
        eq(schema.environmentOperations.id, canaryOperationId),
        eq(schema.environmentOperations.type, "environment.update"),
        eq(schema.environmentOperations.status, "completed"),
        eq(schema.environmentOperations.stage, "environment.update.ready"),
      ),
    });
    if (
      !canaryOperation ||
      canaryOperation.environmentId !== channel.canaryEnvironmentId ||
      canaryOperation.input?.runtimeVersionId !== versionId
    ) {
      throw new Error(
        "Batch mode requires the completed canary operation for this current version.",
      );
    }
    const version = channel.currentVersion;
    const environments = await knowledgeDb.query.environments.findMany({
      where: and(
        eq(schema.environments.provider, "fly"),
        isNull(schema.environments.archivedAt),
        inArray(schema.environments.status, ["ready", "degraded"]),
        or(
          ne(schema.environments.runtimeImage, version.runtimeImage),
          ne(schema.environments.routerImage, version.routerImage),
          isNull(schema.environments.runtimeImage),
          isNull(schema.environments.routerImage),
        ),
      ),
    });
    let queued = 0;
    let skipped = 0;
    for (const environment of environments) {
      try {
        const requested = await runtime.requestEnvironmentRuntimeUpdate({
          organizationId: environment.organizationId,
          environmentId: environment.id,
          runtimeVersionId: versionId,
          actorUserId,
        });
        if (requested.operation.status === "queued") {
          await queue.enqueueEnvironmentOperation(requested.operation.id);
          queued += 1;
        }
      } catch (error) {
        if (
          error instanceof runtime.EnvironmentRuntimeChannelError &&
          ["RUNTIME_UPDATE_CONFLICT", "RUNTIME_ALREADY_CURRENT"].includes(error.code)
        ) {
          skipped += 1;
          continue;
        }
        throw error;
      }
    }
    process.stdout.write(`Queued ${queued} Environment update(s); skipped ${skipped}.\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function loadProductionEnvironment(directory: string) {
  const envFile = join(directory, "production.env");
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
  Object.assign(process.env, dotenv.parse(await readFile(envFile, "utf8")));
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed.`);
}

function argument(name: string) {
  const value = optionalArgument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime update failed."}\n`,
  );
  process.exit(1);
});
