import { eq } from "drizzle-orm";
import {
  confirmExact,
  loadProductionEnvironment,
  productionRuntimeImages,
  productionTag,
  rejectUnknownArguments,
  requiredArgument,
} from "./lib/production-command";

async function main() {
  const args = process.argv.slice(2);
  const tag = productionTag(requiredArgument(args, "--tag"));
  const canaryOperationId = requiredArgument(args, "--canary-operation");
  rejectUnknownArguments(args, ["--tag", "--canary-operation"]);
  const operator = await loadProductionEnvironment();
  const [{ knowledgeDb, schema }, runtime] = await Promise.all([
    import("@/lib/knowledge/db"),
    import("@/lib/environments/runtime-channel"),
  ]);
  const images = productionRuntimeImages(tag);
  const [{ version }, channel, operation] = await Promise.all([
    runtime.registerEnvironmentRuntimeVersion(images),
    runtime.getEnvironmentRuntimeChannel(),
    knowledgeDb.query.environmentOperations.findFirst({
      where: eq(schema.environmentOperations.id, canaryOperationId),
    }),
  ]);
  if (!operation) {
    throw new Error("The canary operation was not found.");
  }
  process.stdout.write(
    `${JSON.stringify({ operator, tag, currentVersion: channel.currentVersion, proposedVersion: version, canaryOperation: { id: operation.id, environmentId: operation.environmentId, status: operation.status, stage: operation.stage, runtimeVersionId: operation.input?.runtimeVersionId } }, null, 2)}\n`,
  );
  await confirmExact(`${tag} ${canaryOperationId}`);
  const activated = await runtime.activateEnvironmentRuntimeVersion({
    runtimeVersionId: version.id,
    canaryOperationId,
  });
  const { logAdminEvent } = await import("@/lib/admin/logs");
  await logAdminEvent({
    category: "environment-runtime",
    action: "environment_runtime.version.activated",
    targetType: "environment_runtime_version",
    targetId: version.id,
    message: "Activated an Environment Runtime version after its exact canary.",
    metadata: {
      operator,
      tag,
      canaryOperationId,
      canaryEnvironmentId: activated.canaryEnvironmentId,
      generation: activated.generation,
      alreadyCurrent: activated.alreadyCurrent,
    },
  });
  process.stdout.write(`${JSON.stringify({ operator, tag, activated }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime activation failed."}\n`,
  );
  process.exit(1);
});
