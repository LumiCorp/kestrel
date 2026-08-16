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
  const environmentId = requiredArgument(args, "--environment");
  const tag = productionTag(requiredArgument(args, "--tag"));
  rejectUnknownArguments(args, ["--environment", "--tag"]);
  const operator = await loadProductionEnvironment();
  const [{ knowledgeDb, schema }, runtime, queue] = await Promise.all([
    import("@/lib/knowledge/db"),
    import("@/lib/environments/runtime-channel"),
    import("@/lib/knowledge/queue"),
  ]);
  const environment = await knowledgeDb.query.environments.findFirst({
    where: eq(schema.environments.id, environmentId),
    columns: {
      id: true,
      organizationId: true,
      provider: true,
      runtimeImage: true,
      routerImage: true,
    },
  });
  if (!environment || environment.provider !== "fly") {
    throw new Error("--environment must identify one Fly Environment.");
  }
  const images = productionRuntimeImages(tag);
  const { version } = await runtime.registerEnvironmentRuntimeVersion(images);
  process.stdout.write(
    `${JSON.stringify({ operator, target: { environmentId, organizationId: environment.organizationId, currentRuntimeImage: environment.runtimeImage, currentRouterImage: environment.routerImage }, requested: { tag, runtimeImage: version.runtimeImage, routerImage: version.routerImage } }, null, 2)}\n`,
  );
  await confirmExact(`${environmentId} ${tag}`);
  const requested = await runtime.requestEnvironmentRuntimeUpdate({
    organizationId: environment.organizationId,
    environmentId,
    runtimeVersionId: version.id,
    actorUserId: null,
  });
  if (requested.operation.status === "queued") {
    await queue.enqueueEnvironmentOperation(requested.operation.id);
  }
  const { logAdminEvent } = await import("@/lib/admin/logs");
  await logAdminEvent({
    category: "environment-runtime",
    action: "environment_runtime.update.requested",
    targetType: "environment",
    targetId: environmentId,
    message: "A production operator requested one Environment runtime update.",
    metadata: { operator, tag, operationId: requested.operation.id },
  });
  process.stdout.write(
    `${JSON.stringify({ operator, tag, environmentId, operationId: requested.operation.id, status: requested.operation.status, stage: requested.operation.stage }, null, 2)}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime update failed."}\n`,
  );
  process.exit(1);
});
